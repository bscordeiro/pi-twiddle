import { describe, it, expect, vi, beforeEach } from "vitest";

interface PickerTestState {
	inputs: Array<{ value: string }>;
	lists: Array<{ items: Array<{ value: string }> }>;
}

function testState(): PickerTestState {
	return (globalThis as unknown as { __pickerTestState: PickerTestState }).__pickerTestState;
}

vi.mock("@earendil-works/pi-tui", () => {
	const state: PickerTestState = { inputs: [], lists: [] };
	(globalThis as unknown as { __pickerTestState: PickerTestState }).__pickerTestState = state;

	class FakeInput {
		value = "";
		onSubmit?: (value: string) => void;
		onEscape?: () => void;
		focused = false;
		constructor(_options?: unknown) {
			state.inputs.push(this);
		}
		getValue() {
			return this.value;
		}
		setValue(value: string) {
			this.value = value;
		}
		handleInput(data: string) {
			if (data === "\x7f") {
				this.value = this.value.slice(0, -1);
			} else if (data === "\r" || data === "\n") {
				this.onSubmit?.(this.value);
			} else if (data.length === 1) {
				this.value += data;
			}
		}
	}

	class FakeSelectList {
		items: Array<{ value: string; label: string }>;
		selectedIndex = 0;
		onSelect?: (item: { value: string }) => void;
		onCancel?: () => void;
		constructor(items: Array<{ value: string; label: string }>) {
			this.items = items;
			state.lists.push(this);
		}
		getSelectedItem() {
			return this.items[this.selectedIndex] ?? null;
		}
		handleInput(data: string) {
			if (data === "up") {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			} else if (data === "down") {
				this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			} else if (data === "confirm") {
				const selected = this.getSelectedItem();
				if (selected) this.onSelect?.(selected);
			} else if (data === "cancel") {
				this.onCancel?.();
			}
		}
	}

	class FakeContainer {
		children: unknown[] = [];
		addChild(child: unknown) {
			this.children.push(child);
		}
		removeChild(child: unknown) {
			this.children = this.children.filter((c) => c !== child);
		}
		clear() {
			this.children = [];
		}
		render() {
			return [];
		}
		invalidate() {}
	}

	class FakeText {
		constructor(_text?: unknown) {}
	}

	return {
		Input: FakeInput,
		SelectList: FakeSelectList,
		Container: FakeContainer,
		Text: FakeText,
	};
});

import { matchOptions, searchableSelect } from "./picker.ts";

const OPTIONS = [
	"openai/gpt-4o  (GPT-4o)",
	"openai/gpt-4o-mini  (GPT-4o mini)",
	"anthropic/claude-sonnet-4-5  (Claude Sonnet 4.5)",
];

const keybindings = {
	matches: (data: string, id: string) => {
		if (id === "tui.select.up") return data === "up";
		if (id === "tui.select.down") return data === "down";
		if (id === "tui.select.confirm") return data === "confirm" || data === "\r";
		if (id === "tui.select.cancel") return data === "cancel" || data === "\x1b";
		return false;
	},
};

function setupTui() {
	let component: any;
	let resolveDone!: (value: string | undefined) => void;
	const donePromise = new Promise<string | undefined>((resolve) => {
		resolveDone = resolve;
	});
	const ctx = {
		mode: "tui",
		ui: {
			select: vi.fn(),
			custom: vi.fn((factory: (...args: any[]) => any) => {
				component = factory({ requestRender: () => {} }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, keybindings, (v: string | undefined) => resolveDone(v));
				return donePromise;
			}),
		},
	};
	return { ctx, getComponent: () => component, donePromise };
}

beforeEach(() => {
	testState().inputs = [];
	testState().lists = [];
});

describe("matchOptions", () => {
	it("returns everything for an empty query", () => {
		expect(matchOptions(OPTIONS, "")).toEqual(OPTIONS);
	});

	it("matches substrings case-insensitively across terms", () => {
		expect(matchOptions(OPTIONS, "SONNET")).toEqual([OPTIONS[2]]);
		expect(matchOptions(OPTIONS, "openai mini")).toEqual([OPTIONS[1]]);
		expect(matchOptions(OPTIONS, "openai sonnet")).toEqual([]);
	});
});

describe("searchableSelect", () => {
	it("falls back to the plain selector outside TUI mode", async () => {
		const select = vi.fn(async () => OPTIONS[1]);
		const custom = vi.fn();
		const ctx = { mode: "print", ui: { select, custom } };
		await expect(searchableSelect(ctx, "Pick:", OPTIONS)).resolves.toBe(OPTIONS[1]);
		expect(select).toHaveBeenCalledTimes(1);
		expect(custom).not.toHaveBeenCalled();
	});

	it("returns undefined without UI for an empty list", async () => {
		const ctx = { mode: "tui", ui: { select: vi.fn(), custom: vi.fn() } };
		await expect(searchableSelect(ctx, "Pick:", [])).resolves.toBeUndefined();
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("filters as the user types and confirms the match", async () => {
		const { ctx, getComponent, donePromise } = setupTui();
		const pending = searchableSelect(ctx, "Pick:", OPTIONS);
		const component = getComponent();
		for (const ch of "mini") component.handleInput(ch);
		component.handleInput("confirm");
		await expect(pending).resolves.toBe(OPTIONS[1]);
		expect(testState().lists.at(-1)?.items.map((i) => i.value)).toEqual([OPTIONS[1]]);
	});

	it("confirms undefined when nothing matches", async () => {
		const { ctx, getComponent, donePromise } = setupTui();
		const pending = searchableSelect(ctx, "Pick:", OPTIONS);
		const component = getComponent();
		for (const ch of "zzz") component.handleInput(ch);
		component.handleInput("confirm");
		await expect(pending).resolves.toBeUndefined();
	});

	it("cancels on escape without choosing", async () => {
		const { ctx, getComponent, donePromise } = setupTui();
		const pending = searchableSelect(ctx, "Pick:", OPTIONS);
		getComponent().handleInput("cancel");
		await expect(pending).resolves.toBeUndefined();
	});

	it("navigates with arrows and confirms", async () => {
		const { ctx, getComponent, donePromise } = setupTui();
		const pending = searchableSelect(ctx, "Pick:", OPTIONS);
		const component = getComponent();
		component.handleInput("down");
		component.handleInput("confirm");
		await expect(pending).resolves.toBe(OPTIONS[1]);
	});
});
