import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./optimizer.ts";

describe("buildSystemPrompt", () => {
	it("returns a non-empty string", () => {
		const result = buildSystemPrompt();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("includes base rules in every prompt", () => {
		const result = buildSystemPrompt();
		expect(result).toContain("Prompt Translator");
		expect(result).toContain("Output ONLY the rewritten prompt");
	});

	it("appends intent adendo for bug_fix", () => {
		const result = buildSystemPrompt({ intent: "bug_fix" });
		expect(result).toContain("Bug Fix Mode");
	});

	it("appends intent adendo for new_feature", () => {
		const result = buildSystemPrompt({ intent: "new_feature" });
		expect(result).toContain("New Feature Mode");
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
	});

	it("adds aggressive compression when level is max", () => {
		const result = buildSystemPrompt({ compressionLevel: "max", scope: "medium" });
		expect(result).toContain("Maximum Compression Mode");
	});

	it("adds aggressive compression for auto only on trivial/low", () => {
		const trivial = buildSystemPrompt({ compressionLevel: "auto", scope: "trivial" });
		const medium = buildSystemPrompt({ compressionLevel: "auto", scope: "medium" });
		expect(trivial).toContain("Maximum Compression Mode");
		expect(medium).not.toContain("Maximum Compression Mode");
	});

	it("does not add aggressive compression when level is off", () => {
		const result = buildSystemPrompt({ compressionLevel: "off", scope: "trivial" });
		expect(result).not.toContain("Maximum Compression Mode");
	});

	it("returns cached result for same options", () => {
		const opts = { intent: "refactor" as const, scope: "low" as const };
		const first = buildSystemPrompt(opts);
		const second = buildSystemPrompt(opts);
		expect(first).toBe(second); // same reference from cache
	});
});
