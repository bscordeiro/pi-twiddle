import { describe, it, expect } from "vitest";
import { detectScope } from "./optimizer.ts";

describe("detectScope", () => {
	it("classifies short prompts as trivial", () => {
		expect(detectScope("fix bug")).toBe("trivial");
	});

	it("classifies medium-length prompts as low", () => {
		// > 20 words → "low" (threshold in detectScope)
		const text =
			"fix the authentication bug in the login endpoint so that users can successfully sign in without getting a 401 error on valid credentials";
		expect(detectScope(text)).toBe("low");
	});

	it("classifies 80+ word prompts as medium", () => {
		const text = Array(85).fill("word").join(" ");
		expect(detectScope(text)).toBe("medium");
	});

	it("classifies 150+ word prompts as high", () => {
		const text = Array(155).fill("word").join(" ");
		expect(detectScope(text)).toBe("high");
	});

	it("classifies multi-line prompts with code blocks as epic", () => {
		const lines = Array(16).fill("a line of text").join("\n");
		const text = `${lines}\n\`\`\`ts\nconst x = 1;\n\`\`\``;
		expect(detectScope(text)).toBe("epic");
	});

	it("does not classify multi-line without code block as epic", () => {
		const text = Array(16).fill("a line of text").join("\n");
		expect(detectScope(text)).not.toBe("epic");
	});
});
