/**
 * Searchable single-select for Twiddle.
 * Type-to-filter on top of pi-tui primitives (Input + SelectList), the same
 * bricks Pi's native model selector uses. Falls back to the plain selector
 * outside TUI mode (RPC/print/JSON), where custom components are unavailable.
 */
import { Container, Input, SelectList, Text } from "@earendil-works/pi-tui";

export function matchOptions(options: string[], query: string): string[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return options;
	return options.filter((option) => {
		const haystack = option.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
}

function selectListTheme(theme: { fg: (color: string, text: string) => string }) {
	return {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.fg("accent", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

export async function searchableSelect(
	ctx: any,
	title: string,
	options: string[],
): Promise<string | undefined> {
	if (options.length === 0) return undefined;
	if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
		return ctx.ui.select(title, options);
	}
	return ctx.ui.custom((tui: any, theme: any, keybindings: any, done: (v: string | undefined) => void) => {
		let closed = false;
		const finish = (value: string | undefined) => {
			if (closed) return;
			closed = true;
			done(value);
		};

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		const input = new Input({ prompt: "Search: ", placeholder: "type to filter" });
		container.addChild(input);
		const listHolder = new Container();
		container.addChild(listHolder);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel • type to filter"), 1, 0),
		);

		const buildList = (query: string) => {
			const items = matchOptions(options, query).map((option) => ({
				value: option,
				label: option,
			}));
			const list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), selectListTheme(theme));
			list.onSelect = (item) => finish(item.value);
			list.onCancel = () => finish(undefined);
			return list;
		};

		let list = buildList("");
		listHolder.addChild(list);

		input.onSubmit = () => {
			const selected = list.getSelectedItem();
			finish(selected ? selected.value : undefined);
		};
		input.onEscape = () => finish(undefined);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			handleInput: (data: string) => {
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.cancel")
				) {
					list.handleInput(data);
				} else if (keybindings.matches(data, "tui.select.confirm")) {
					// Confirm with no matches chooses nothing instead of hanging.
					if (list.getSelectedItem()) {
						list.handleInput(data);
					} else {
						finish(undefined);
					}
				} else {
					input.handleInput(data);
					listHolder.clear();
					list = buildList(input.getValue());
					listHolder.addChild(list);
				}
				tui.requestRender();
			},
		};
	});
}
