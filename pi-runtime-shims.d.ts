declare module "@earendil-works/pi-coding-agent" {
	export type ExtensionAPI = any;
}

declare module "@earendil-works/pi-ai" {
	export type Model = {
		provider: string;
		id: string;
		name: string;
	};
}

declare module "@earendil-works/pi-tui" {
	export const Text: any;
}
