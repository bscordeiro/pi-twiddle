import { describe, expect, it } from "vitest";
import { decideMissingModelSetup, isTwiddleCommand } from "./missing-model-warning.ts";

describe("isTwiddleCommand", () => {
	it("matches base twiddle command", () => {
		expect(isTwiddleCommand("/twiddle")).toBe(true);
	});

	it("matches twiddle subcommands", () => {
		expect(isTwiddleCommand("/twiddle-model")).toBe(true);
	});

	it("ignores non-twiddle commands", () => {
		expect(isTwiddleCommand("/model")).toBe(false);
	});
});

describe("decideMissingModelSetup", () => {
	it("does nothing when model is configured", () => {
		expect(
			decideMissingModelSetup("optimize this", {
				hasModel: true,
				sessionSilenced: false,
			}),
		).toEqual({ missingModel: false, shouldPrompt: false });
	});

	it("prompts for first eligible Twiddle use without model", () => {
		expect(
			decideMissingModelSetup("optimize this", {
				hasModel: false,
				sessionSilenced: false,
			}),
		).toEqual({ missingModel: true, shouldPrompt: true });
	});

	it("stays silent after user cancels setup in this session", () => {
		expect(
			decideMissingModelSetup("optimize this", {
				hasModel: false,
				sessionSilenced: true,
			}),
		).toEqual({ missingModel: true, shouldPrompt: false });
	});

	it("does not prompt for twiddle setup commands", () => {
		expect(
			decideMissingModelSetup("/twiddle-model", {
				hasModel: false,
				sessionSilenced: false,
			}),
		).toEqual({ missingModel: true, shouldPrompt: false });
	});

	it("does not prompt for empty text", () => {
		expect(
			decideMissingModelSetup("   ", {
				hasModel: false,
				sessionSilenced: false,
			}),
		).toEqual({ missingModel: true, shouldPrompt: false });
	});
});
