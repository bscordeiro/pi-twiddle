import { describe, expect, it } from "vitest";
import {
	applyKnownTransformations,
	applyTextToUserMessage,
	loadAppliedTransformations,
	messageSignature,
} from "./history.ts";

describe("history transformation helpers", () => {
	it("loads active branch records instead of all session records", () => {
		const active = { type: "custom", customType: "twiddle-comparison", data: { original: "a", applied: "A" } };
		const abandoned = { type: "custom", customType: "twiddle-comparison", data: { original: "a", applied: "old A" } };
		const manager = { getBranch: () => [active], getEntries: () => [active, abandoned] };
		expect(loadAppliedTransformations(manager)).toEqual([{ original: "a", applied: "A" }]);
	});

	it("updates only first text block and preserves attachments", () => {
		const message = { role: "user", content: [
			{ type: "text", text: "before" },
			{ type: "image", data: "synthetic" },
		] };
		expect(applyTextToUserMessage(message, "after")).toEqual({
			role: "user",
			content: [{ type: "text", text: "after" }, { type: "image", data: "synthetic" }],
		});
	});

	it("reapplies records in reverse order for duplicate prompts", () => {
		const messages = [
			{ role: "user", content: "same" },
			{ role: "user", content: "same" },
		];
		applyKnownTransformations(messages, [
			{ original: "same", applied: "first" },
			{ original: "same", applied: "second" },
		], false);
		expect(messages.map((message) => messageSignature(message))).toEqual(["first", "second"]);
	});
});
