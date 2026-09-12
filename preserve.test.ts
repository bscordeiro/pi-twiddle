import { describe, it, expect } from "vitest";
import { extractProtectedFragments, restoreFragments } from "./preserve.ts";

describe("extractProtectedFragments", () => {
	it("extracts code blocks and replaces with placeholders", () => {
		const input = "Check this:\n```ts\nconst x = 1;\n```\nDone.";
		const { sanitized, fragments } = extractProtectedFragments(input);
		expect(sanitized).not.toContain("const x");
		expect(sanitized).toContain("{{PRESERVE_");
		expect(fragments.size).toBeGreaterThan(0);
	});

	it("extracts inline code", () => {
		const input = "Use `myFunction()` here.";
		const { sanitized, fragments } = extractProtectedFragments(input);
		expect(sanitized).not.toContain("myFunction");
		expect(fragments.size).toBe(1);
	});

	it("extracts URLs", () => {
		const input = "See https://example.com/path for details.";
		const { sanitized, fragments } = extractProtectedFragments(input);
		expect(sanitized).not.toContain("https://");
		expect(fragments.size).toBe(1);
	});

	it("extracts hex hashes (mixed alpha+digits)", () => {
		const input = "Commit abc1234 broke the build.";
		const { sanitized, fragments } = extractProtectedFragments(input);
		expect(sanitized).not.toContain("abc1234");
		expect(fragments.size).toBe(1);
	});

	it("does NOT extract pure-numeric strings as hashes", () => {
		const input = "Error code 1234567 appeared.";
		const { sanitized, fragments } = extractProtectedFragments(input);
		expect(sanitized).toContain("1234567");
		expect(fragments.size).toBe(0);
	});

	it("does NOT extract common hex-looking words as hashes", () => {
		const input = "Use deadbeef as a placeholder.";
		// "deadbeef" has no digits → should NOT match
		const { sanitized, fragments } = extractProtectedFragments(input);
		expect(sanitized).toContain("deadbeef");
		expect(fragments.size).toBe(0);
	});

	it("extracts semver strings", () => {
		const input = "Upgrade to 1.2.3 to fix the issue.";
		const { sanitized, fragments } = extractProtectedFragments(input);
		expect(sanitized).not.toContain("1.2.3");
		expect(fragments.size).toBe(1);
	});

	it("protects literal placeholder syntax from colliding with generated markers", () => {
		const input = "Keep {{PRESERVE_1}} and `fn()` unchanged.";
		const { sanitized, fragments } = extractProtectedFragments(input);
		expect(restoreFragments(sanitized, fragments)).toBe(input);
		expect(fragments.size).toBe(2);
	});

	it("leaves plain text untouched", () => {
		const input = "Just a plain sentence here.";
		const { sanitized, fragments } = extractProtectedFragments(input);
		expect(sanitized).toBe(input);
		expect(fragments.size).toBe(0);
	});
});

describe("restoreFragments", () => {
	it("round-trips code blocks correctly", () => {
		const input = "Prefix\n```ts\nconst x = 1;\n```\nSuffix";
		const { sanitized, fragments } = extractProtectedFragments(input);
		const restored = restoreFragments(sanitized, fragments);
		expect(restored).toBe(input);
	});

	it("round-trips multiple fragments", () => {
		const input = "Use `fn()` and see https://example.com for version 2.0.1.";
		const { sanitized, fragments } = extractProtectedFragments(input);
		const restored = restoreFragments(sanitized, fragments);
		expect(restored).toBe(input);
	});

	it("leaves unknown placeholders intact", () => {
		const fragments = new Map<number, string>();
		const result = restoreFragments("Value: {{PRESERVE_99}}", fragments);
		expect(result).toBe("Value: {{PRESERVE_99}}");
	});
});
