import { describe, it, expect } from "vitest";
import { countTokens } from "./tokenizer.ts";

describe("countTokens", () => {
	it("returns 0 for empty string", () => {
		expect(countTokens("")).toBe(0);
	});

	it("returns a positive count for non-empty text", () => {
		expect(countTokens("hello world")).toBeGreaterThan(0);
	});

	it("approximates 1 token per 4 chars (ceiling)", () => {
		// "test" = 4 chars → 1 token
		expect(countTokens("test")).toBe(1);
		// "hello" = 5 chars → 2 tokens (ceil(5/4))
		expect(countTokens("hello")).toBe(2);
	});

	it("scales linearly with text length", () => {
		const short = countTokens("ab");
		const long = countTokens("ab".repeat(10));
		expect(long).toBeGreaterThan(short);
	});
});
