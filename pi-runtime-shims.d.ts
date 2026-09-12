declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionAPI {
		on(name: string, handler: (event: any, ctx: any) => unknown): void;
		registerCommand(name: string, command: {
			description?: string;
			handler: (args: string, ctx: any) => Promise<unknown>;
		}): void;
		registerMessageRenderer(customType: string, renderer: (...args: any[]) => unknown): void;
		registerEntryRenderer(customType: string, renderer: (...args: any[]) => unknown): void;
		appendEntry(customType: string, data?: Record<string, unknown>): void;
		getThinkingLevel(): string;
		exec(command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}>;
	}
}

declare module "@earendil-works/pi-ai" {
	export type Api = string;
	export type Model<TApi extends Api = Api> = {
		provider: string;
		id: string;
		name: string;
	};
}

declare module "@earendil-works/pi-tui" {
	export class Text {
		constructor(text?: string, paddingX?: number, paddingY?: number);
	}
	export class Input {
		constructor(options?: { prompt?: string; placeholder?: string });
		onSubmit?: (value: string) => void;
		onEscape?: () => void;
		focused: boolean;
		getValue(): string;
		handleInput(data: string): void;
	}
	export class SelectList {
		constructor(items: Array<{ value: string; label: string }>, maxVisible: number, theme: Record<string, (text: string) => string>);
		onSelect?: (item: { value: string; label: string }) => void;
		onCancel?: () => void;
		getSelectedItem(): { value: string; label: string } | null;
		handleInput(data: string): void;
	}
	export class Container {
		addChild(child: unknown): void;
		clear(): void;
		invalidate(): void;
		render(width: number): string[];
	}
}
