import { describe, it, expect } from "vitest";
import { access } from "node:fs/promises";
import { buildSystemPrompt, optimizePrompt } from "./optimizer.ts";

describe("buildSystemPrompt", () => {
	it("returns a non-empty string", () => {
		const result = buildSystemPrompt();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("includes base rules in every prompt", () => {
		const result = buildSystemPrompt();
		expect(result).toContain("prompt translator");
		expect(result).toContain("Output ONLY the rewritten prompt");
	});

	it("forbids scope expansion in the base prompt", () => {
		const result = buildSystemPrompt();
		expect(result).toContain("Never add requirements");
		expect(result).toContain("Fix the login bug.\" → \"Fix the login bug.");
		expect(result).not.toContain("Investigate and fix the login issue");
	});

	it("appends intent adendo for bug_fix", () => {
		const result = buildSystemPrompt({ intent: "bug_fix" });
		expect(result).toContain("Bug Fix Mode");
	});

	it("appends intent adendo for new_feature", () => {
		const result = buildSystemPrompt({ intent: "new_feature" });
		expect(result).toContain("New Feature Mode");
	});

	it("never instructs the model to invent requirements for any intent", () => {
		const intents = ["bug_fix", "new_feature", "refactor", "research", "testing", "review", "docs", "infrastructure", "design"] as const;
		for (const intent of intents) {
			const result = buildSystemPrompt({ intent });
			expect(result).not.toMatch(/Structure the request with clear acceptance criteria\./);
			expect(result).toMatch(/only when|already present|if mentioned|Do NOT add|Never add|must do the same thing/i);
		}
	});

	it("includes project context section when provided", () => {
		const result = buildSystemPrompt({
			projectContext: {
				language: "TypeScript",
				runtime: "node",
				framework: "NestJS",
				packageManager: "pnpm",
				type: "single",
			},
		});
		expect(result).toContain("Project Context");
		expect(result).toContain("TypeScript");
		expect(result).toContain("NestJS");
	});

	it("includes monorepo flag when project type is monorepo", () => {
		const result = buildSystemPrompt({
			projectContext: {
				language: "TypeScript",
				runtime: "node",
				type: "monorepo",
			},
		});
		expect(result).toContain("monorepo");
	});

	it("includes thinking-level hint for high", () => {
		const result = buildSystemPrompt({ thinkingLevel: "high" });
		expect(result).toContain("high-thinking mode");
	});

	it("includes thinking-level hint for low", () => {
		const result = buildSystemPrompt({ thinkingLevel: "low" });
		expect(result).toContain("low-thinking mode");
	});

	it("does not include thinking-level section for unrecognised level", () => {
		const base = buildSystemPrompt();
		const withUnknown = buildSystemPrompt({ thinkingLevel: "medium" });
		expect(withUnknown).toBe(base); // no extra section added
	});

	it("includes scope directive for trivial", () => {
		const result = buildSystemPrompt({ scope: "trivial" });
		expect(result).toContain("TRIVIAL");
	});

	it("includes scope directive for epic", () => {
		const result = buildSystemPrompt({ scope: "epic" });
		expect(result).toContain("EPIC");
		expect(result).toContain("unambiguous handoff");
		expect(result).toContain("Do not create a plan");
		expect(result).not.toContain("safe multi-step execution");
	});

	it("returns cached result for same options", () => {
		const opts = { intent: "refactor" as const, scope: "low" as const };
		const first = buildSystemPrompt(opts);
		const second = buildSystemPrompt(opts);
		expect(first).toBe(second); // same reference from cache
	});
});

describe("optimizePrompt fragment integrity", () => {
	const modelRef = { provider: "mock", id: "mock" };

	it("transports oversized prompts through a temporary file instead of argv", async () => {
		const input = "x".repeat(140_000);
		let promptArg = "";
		const execFn = async (args: string[]) => {
			promptArg = args.at(-1) ?? "";
			await access(promptArg.slice(1));
			return { stdout: input, stderr: "", code: 0, killed: false };
		};
		await optimizePrompt(input, modelRef, execFn, 500);
		expect(promptArg.startsWith("@")).toBe(true);
		await expect(access(promptArg.slice(1))).rejects.toThrow();
	});

	it("preserves literal placeholder syntax alongside protected fragments", async () => {
		const input = "Keep {{PRESERVE_1}} and `fn()` unchanged.";
		const execFn = async (_args: string[]) => ({
			stdout: "Keep {{PRESERVE_1}} and {{PRESERVE_2}} unchanged.",
			stderr: "",
			code: 0,
			killed: false,
		});
		const result = await optimizePrompt(input, modelRef, execFn, 500);
		expect(result.optimizedText).toBe(input);
	});

	it("rejects output that drops a protected placeholder", async () => {
		const execFn = async () => ({
			stdout: "Explain the error without the code.",
			stderr: "",
			code: 0,
			killed: false,
		});
		await expect(
			optimizePrompt("Explain this:\n```ts\nconst x = 1;\n```", modelRef, execFn, 500),
		).rejects.toThrow(/protected fragment/);
	});

	it("rejects output that duplicates a protected placeholder", async () => {
		const execFn = async () => ({
			stdout: "Check {{PRESERVE_1}} and again {{PRESERVE_1}}.",
			stderr: "",
			code: 0,
			killed: false,
		});
		await expect(
			optimizePrompt("Check `myFunction()` now.", modelRef, execFn, 500),
		).rejects.toThrow(/protected fragment/);
	});

	it("rejects output that invents an unknown placeholder", async () => {
		const execFn = async () => ({
			stdout: "Do it {{PRESERVE_99}}.",
			stderr: "",
			code: 0,
			killed: false,
		});
		await expect(
			optimizePrompt("Just a plain sentence here.", modelRef, execFn, 500),
		).rejects.toThrow(/protected fragment/);
	});

	it("restores output that keeps every placeholder exactly once", async () => {
		const execFn = async () => ({
			stdout: "Explain {{PRESERVE_1}} briefly.",
			stderr: "",
			code: 0,
			killed: false,
		});
		const result = await optimizePrompt("Explain `myFunction()` briefly.", modelRef, execFn, 500);
		expect(result.optimizedText).toBe("Explain `myFunction()` briefly.");
		expect(result.exceedsBudget).toBe(false);
	});
});
