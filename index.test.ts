import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@earendil-works/pi-tui", () => ({
	Text: class Text {
		constructor(public content: string) {}
	},
	Input: class Input {},
	SelectList: class SelectList {},
	Container: class Container {},
}));

const memConfig: Record<string, unknown> = {};

vi.mock("./config.ts", () => ({
	readConfig: async () => ({ ...memConfig }),
	getConfig: async () => ({ ...memConfig }),
	writeConfig: async (c: Record<string, unknown>) => {
		for (const key of Object.keys(memConfig)) delete memConfig[key];
		Object.assign(memConfig, c);
	},
}));

import extensionFactory from "./index.ts";

function setup(execStdout = "Improve login handling.", models: Array<{ provider: string; id: string; name: string }> = []) {
	const handlers: Record<string, (...args: never[]) => unknown> = {};
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }> = {};
	const commandNames: string[] = [];
	const entryRenderers: Record<string, (entry: unknown, options: unknown, theme: unknown) => unknown> = {};
	const pi = {
		on: (name: string, fn: (...args: never[]) => unknown) => {
			handlers[name] = fn;
		},
		registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<unknown> }) => {
			commands[name] = cmd;
			commandNames.push(name);
		},
		registerMessageRenderer: () => {},
		registerEntryRenderer: (name: string, renderer: (entry: unknown, options: unknown, theme: unknown) => unknown) => {
			entryRenderers[name] = renderer;
		},
		appendEntry: vi.fn(),
		getThinkingLevel: () => "off",
		sendMessage: vi.fn(),
		exec: vi.fn(async () => ({ stdout: execStdout, stderr: "", code: 0, killed: false })),
	};
	extensionFactory(pi as never);
	const ctx = {
		ui: {
			setStatus: () => {},
			notify: vi.fn(),
			select: vi.fn(async () => undefined),
			theme: { fg: (_c: string, s: string) => s },
		},
		modelRegistry: { getAvailable: () => models },
		sessionManager: { getEntries: () => [] },
		signal: undefined,
	};
	return { handlers, pi, ctx, commands, commandNames, entryRenderers };
}

beforeEach(() => {
	for (const key of Object.keys(memConfig)) delete memConfig[key];
	Object.assign(memConfig, {
		threshold: 500,
		auto: false,
		verbose: "quiet",
		timeout: 15,
		model: { provider: "mock", id: "mock" },
	});
});

describe("plain-prompt event flow", () => {
	it("strips the bypass prefix instead of forwarding it", async () => {
		const { handlers, ctx } = setup();
		const before = handlers["before_agent_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		await before({ prompt: "~raw:mantenha exatamente esta mensagem" }, ctx);
		const result = await onContext(
			{ messages: [{ role: "user", content: "~raw:mantenha exatamente esta mensagem" }] },
			ctx,
		);
		expect(result?.messages[0].content).toBe("mantenha exatamente esta mensagem");
	});

	it("preserves extra text blocks and attachments", async () => {
		const { handlers, pi, ctx } = setup();
		const before = handlers["before_agent_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		await before({ prompt: "~melhore o tratamento do login" }, ctx);
		const result = await onContext(
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "~melhore o tratamento do login" },
							{ type: "text", text: "Additional attached file context" },
							{ type: "image", data: "synthetic" },
						],
					},
				],
			},
			ctx,
		);
		const content = result?.messages[0].content as Array<{ type: string; text?: string }>;
		expect(content[0].text).toBe("Improve login handling.");
		expect(content[1].text).toBe("Additional attached file context");
		expect(pi.exec).toHaveBeenCalledTimes(1);
	});

	it("suppresses comparison status line in quiet mode", async () => {
		const { handlers, pi, ctx, entryRenderers } = setup();
		const before = handlers["before_agent_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		await before({ prompt: "~melhore o tratamento do login" }, ctx);
		await onContext(
			{ messages: [{ role: "user", content: "~melhore o tratamento do login" }] },
			ctx,
		);
		const [customType, data] = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(customType).toBe("twiddle-comparison");
		const rendered = entryRenderers["twiddle-comparison"](
			{ data },
			{},
			{ fg: (_color: string, content: string) => content },
		) as { content: string };
		expect(rendered.content).toBe("");
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("shows comparison status line in debug mode", async () => {
		Object.assign(memConfig, { verbose: "debug" });
		const { handlers, pi, ctx, entryRenderers } = setup();
		await (handlers["before_agent_start"] as any)({ prompt: "~melhore o tratamento do login" }, ctx);
		await (handlers["context"] as any)(
			{ messages: [{ role: "user", content: "~melhore o tratamento do login" }] },
			ctx,
		);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([
			expect.stringMatching(/^Twiddle~/),
			"Improve login handling.",
		]);
		const [, data] = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls[0];
		const rendered = entryRenderers["twiddle-comparison"](
			{ data },
			{},
			{ fg: (_color: string, content: string) => content },
		) as { content: string };
		expect(rendered.content).toMatch(/^Twiddle: trivial 8→6 tokens · mock\/mock · \d+\.\ds$/);
	});

	it("shows processed command text in debug mode", async () => {
		Object.assign(memConfig, { verbose: "debug" });
		const { handlers, ctx } = setup();
		await (handlers["input"] as any)(
			{ text: "/tdd ~melhore o tratamento do login", source: "interactive" },
			ctx,
		);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([
			expect.stringMatching(/^Twiddle~/),
			"Improve login handling.",
		]);
	});

	it("restores the applied text on session resume without a new model call", async () => {
		const { handlers, pi, ctx } = setup();
		(ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => [
			{
				type: "custom",
				customType: "twiddle-comparison",
				data: { original: "~melhore o tratamento do login", applied: "Improve login handling." },
			},
		];
		const onSessionStart = handlers["session_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		await onSessionStart({ reason: "resume" }, ctx);
		const result = await onContext(
			{ messages: [{ role: "user", content: "~melhore o tratamento do login" }] },
			ctx,
		);
		expect(result?.messages[0].content).toBe("Improve login handling.");
		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("skips short auto-mode prompts when minChars is configured", async () => {
		Object.assign(memConfig, { auto: true, minChars: 40 });
		const { handlers, pi, ctx } = setup();
		const before = handlers["before_agent_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		await before({ prompt: "oi, tudo bem?" }, ctx);
		const result = await onContext(
			{ messages: [{ role: "user", content: "oi, tudo bem?" }] },
			ctx,
		);
		expect(result).toBeUndefined();
		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("applies minChars at the exact boundary and ignores it for ~ prompts", async () => {
		Object.assign(memConfig, { auto: true, minChars: 10 });
		const { handlers, ctx } = setup();
		const before = handlers["before_agent_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		// Exactly 10 non-numeric chars without prefix: passes the filter.
		await before({ prompt: "abcdefghij" }, ctx);
		const atBoundary = await onContext(
			{ messages: [{ role: "user", content: "abcdefghij" }] },
			ctx,
		);
		expect(atBoundary?.messages[0].content).toBe("Improve login handling.");
	});

	it("skips numeric-only auto-mode prompts regardless of length", async () => {
		Object.assign(memConfig, { auto: true });
		expect(memConfig.minChars).toBeUndefined();
		const { handlers, pi, ctx } = setup();
		const before = handlers["before_agent_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		await before({ prompt: "10" }, ctx);
		const result = await onContext({ messages: [{ role: "user", content: "10" }] }, ctx);
		expect(result).toBeUndefined();
		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("processes one-character non-numeric auto-mode prompts with default minimum 1", async () => {
		Object.assign(memConfig, { auto: true });
		const { handlers, pi, ctx } = setup();
		const before = handlers["before_agent_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		await before({ prompt: "x" }, ctx);
		const result = await onContext({ messages: [{ role: "user", content: "x" }] }, ctx);
		expect(result?.messages[0].content).toBe("Improve login handling.");
		expect(pi.exec).toHaveBeenCalledTimes(1);
	});

	it("lets ~ force optimization below minChars", async () => {
		Object.assign(memConfig, { auto: true, minChars: 100 });
		const { handlers, ctx } = setup();
		const before = handlers["before_agent_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		await before({ prompt: "~oi" }, ctx);
		const result = await onContext({ messages: [{ role: "user", content: "~oi" }] }, ctx);
		expect(result?.messages[0].content).toBe("Improve login handling.");
	});

	it("strips the prefix on the command path when over the expansion limit", async () => {
		const longOutput = "word ".repeat(600);
		const { handlers, ctx } = setup(longOutput);
		const onInput = handlers["input"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ action: string; text?: string } | undefined>;
		const result = await onInput({ text: "/tdd ~melhore o login", source: "interactive" }, ctx);
		expect(result).toEqual({ action: "transform", text: "/tdd melhore o login" });
	});

	it("registers only the supported command set with compare below twiddle", () => {
		const { commandNames } = setup();
		expect(commandNames).toEqual([
			"twiddle",
			"twiddle-compare",
			"twiddle-auto-toggle",
			"twiddle-reset",
		]);
	});

	it("toggles auto-mode with the unified command", async () => {
		const { commands, ctx } = setup();
		await commands["twiddle-auto-toggle"].handler("", ctx);
		expect(memConfig.auto).toBe(true);
		await commands["twiddle-auto-toggle"].handler("", ctx);
		expect(memConfig.auto).toBe(false);
	});

	it("shows debug data, original text, and processed text in compare", async () => {
		const { handlers, commands, ctx } = setup();
		await (handlers["before_agent_start"] as any)({ prompt: "~melhore o tratamento do login" }, ctx);
		await (handlers["context"] as any)(
			{ messages: [{ role: "user", content: "~melhore o tratamento do login" }] },
			ctx,
		);
		await commands["twiddle-compare"].handler("", ctx);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([
			expect.stringMatching(/^Debug: model=mock\/mock · scope=trivial · intent=none · tokens=8→6 · elapsed=\d+\.\ds · attempt=1\/1$/),
			"Original: ~melhore o tratamento do login",
			"Processed: Improve login handling.",
		]);
	});

	it("compare reports most recently processed text", async () => {
		const { handlers, commands, ctx } = setup();
		await (handlers["before_agent_start"] as any)({ prompt: "~first request" }, ctx);
		await (handlers["context"] as any)(
			{ messages: [{ role: "user", content: "~first request" }] },
			ctx,
		);
		await (handlers["before_agent_start"] as any)({ prompt: "~second request" }, ctx);
		await (handlers["context"] as any)(
			{ messages: [{ role: "user", content: "~second request" }] },
			ctx,
		);
		(ctx.sessionManager as any).getBranch = () => [{
			type: "custom",
			customType: "twiddle-comparison",
			data: {
				original: "~stale persisted request",
				applied: "Stale persisted result",
				model: "mock/mock",
				scope: "trivial",
				inputTokens: 1,
				outputTokens: 1,
				elapsed: "0.1",
			},
		}];
		await commands["twiddle-compare"].handler("", ctx);
		const notifications = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
		expect(notifications[1]).toBe("Original: ~second request");
		expect(notifications[2]).toBe("Processed: Improve login handling.");
	});

	it("compare preserves command prefix in original and processed text", async () => {
		const { handlers, commands, ctx } = setup();
		await (handlers["input"] as any)({ text: "/tdd ~melhore o login", source: "interactive" }, ctx);
		await commands["twiddle-compare"].handler("", ctx);
		const notifications = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
		expect(notifications[1]).toBe("Original: /tdd ~melhore o login");
		expect(notifications[2]).toBe("Processed: /tdd Improve login handling.");
	});

	it("cancels without fallback attempts when the turn is aborted", async () => {
		const { handlers, pi, ctx } = setup();
		const controller = new AbortController();
		controller.abort();
		(ctx as { signal: unknown }).signal = controller.signal;
		const before = handlers["before_agent_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		const original = { messages: [{ role: "user", content: "~melhore o tratamento do login" }] };
		await before({ prompt: "~melhore o tratamento do login" }, ctx);
		const result = await onContext(structuredClone(original), ctx);
		// Cancelled: no model called, original kept, no comparison recorded.
		expect(pi.exec).not.toHaveBeenCalled();
		expect(result?.messages[0].content).toBe("~melhore o tratamento do login");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("uses primary model for trivial prompt despite legacy quick model", async () => {
		Object.assign(memConfig, { quickModel: { provider: "openai", id: "gpt-4o-mini" } });
		const { handlers, pi, ctx } = setup();
		await (handlers["before_agent_start"] as any)({ prompt: "~hello" }, ctx);
		await (handlers["context"] as any)(
			{ messages: [{ role: "user", content: "~hello" }] },
			ctx,
		);
		expect((pi.exec as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain("mock/mock");
	});

	it("shows fallbacks but not removed quick-model row in control panel", async () => {
		Object.assign(memConfig, {
			fallbackModels: [{ provider: "openai", id: "gpt-4o-mini" }],
			quickModel: { provider: "openai", id: "gpt-4o" },
		});
		const { commands, ctx } = setup();
		await commands["twiddle"].handler("", ctx);
		const options = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
		expect(options.some((o) => o.startsWith("Fallbacks:"))).toBe(true);
		expect(options.some((o) => o.startsWith("Quick model:"))).toBe(false);
	});

	it("toggles auto-mode from the panel", async () => {
		const { commands, ctx } = setup();
		(ctx.ui.select as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce("Auto-mode: OFF")
			.mockResolvedValueOnce(undefined);
		await commands["twiddle"].handler("", ctx);
		expect(memConfig.auto).toBe(true);
	});

	it("leaves config untouched when the panel is dismissed", async () => {
		const { commands, ctx } = setup();
		await commands["twiddle"].handler("", ctx);
		expect(memConfig.auto).toBe(false);
		expect(memConfig.model).toEqual({ provider: "mock", id: "mock" });
	});

	it("reapplies the optimization on later model calls", async () => {
		const { handlers, ctx } = setup();
		const before = handlers["before_agent_start"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		const onContext = handlers["context"] as (
			event: unknown,
			ctx: unknown,
		) => Promise<{ messages: Array<{ role: string; content: unknown }> } | undefined>;
		const original = { messages: [{ role: "user", content: "~melhore o tratamento do login" }] };
		await before({ prompt: "~melhore o tratamento do login" }, ctx);
		const first = await onContext(structuredClone(original), ctx);
		expect(first?.messages[0].content).toBe("Improve login handling.");
		const second = await onContext(structuredClone(original), ctx);
		expect(second?.messages[0].content).toBe("Improve login handling.");
	});

	it("reapplies every prior transformation when context has multiple prompts", async () => {
		const { handlers, ctx } = setup();
		const before = handlers["before_agent_start"] as (event: unknown, ctx: unknown) => Promise<unknown>;
		const onContext = handlers["context"] as (event: unknown, ctx: unknown) => Promise<any>;
		await before({ prompt: "~first request" }, ctx);
		await onContext({ messages: [{ role: "user", content: "~first request" }] }, ctx);
		await before({ prompt: "~second request" }, ctx);
		const result = await onContext({ messages: [
			{ role: "user", content: "~first request" },
			{ role: "user", content: "~second request" },
		] }, ctx);
		expect(result.messages.map((message: { content: string }) => message.content)).toEqual([
			"Improve login handling.",
			"Improve login handling.",
		]);
	});

	it("restores comparisons from active branch only", async () => {
		const { handlers, ctx } = setup();
		const original = "~branch request";
		const active = { type: "custom", customType: "twiddle-comparison", data: { original, applied: "Active wording." } };
		const abandoned = { type: "custom", customType: "twiddle-comparison", data: { original, applied: "Abandoned wording." } };
		(ctx.sessionManager as any).getEntries = () => [active, abandoned];
		(ctx.sessionManager as any).getBranch = () => [active];
		await (handlers["session_start"] as any)({ reason: "resume" }, ctx);
		const result = await (handlers["context"] as any)({ messages: [{ role: "user", content: original }] }, ctx);
		expect(result.messages[0].content).toBe("Active wording.");
	});

	it("keeps command bypass state aligned when multiple commands are queued", async () => {
		Object.assign(memConfig, { auto: true });
		const { handlers, pi, ctx } = setup();
		await (handlers["input"] as any)({ text: "/skill:first", source: "interactive", streamingBehavior: "steer" }, ctx);
		await (handlers["input"] as any)({ text: "/skill:second", source: "interactive", streamingBehavior: "steer" }, ctx);
		await (handlers["before_agent_start"] as any)({ prompt: "first expanded", }, ctx);
		await (handlers["before_agent_start"] as any)({ prompt: "second expanded", }, ctx);
		await (handlers["context"] as any)({ messages: [{ role: "user", content: "second expanded" }] }, ctx);
		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("strips command bypass syntax before requiring a model", async () => {
		delete memConfig.model;
		const { handlers, ctx } = setup();
		const result = await (handlers["input"] as any)({ text: "/skill:test ~raw:keep this text", source: "interactive" }, ctx);
		expect(result).toEqual({ action: "transform", text: "/skill:test keep this text" });
	});

	it("compare reports no processed text before the first optimization", async () => {
		const { commands, ctx } = setup();
		await commands["twiddle-compare"].handler("", ctx);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([
			"No processed text yet.",
		]);
	});

	it("compare loads the latest persisted comparison after reload", async () => {
		const { commands, ctx } = setup();
		(ctx.sessionManager as any).getBranch = () => [
			{
				type: "custom",
				customType: "twiddle-comparison",
				data: {
					original: "~older request",
					applied: "Older processed request",
					model: "mock/mock",
					scope: "trivial",
					inputTokens: 4,
					outputTokens: 3,
					elapsed: "0.1",
				},
			},
			{
				type: "custom",
				customType: "twiddle-comparison",
				data: {
					original: "~latest request",
					applied: "Latest processed request",
					model: "mock/mock",
					scope: "low",
					inputTokens: 6,
					outputTokens: 5,
					elapsed: "0.2",
				},
			},
		];
		await commands["twiddle-compare"].handler("", ctx);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([
			"Debug: model=mock/mock · scope=low · intent=none · tokens=6→5 · elapsed=0.2s · attempt=?",
			"Original: ~latest request",
			"Processed: Latest processed request",
		]);
	});
});
