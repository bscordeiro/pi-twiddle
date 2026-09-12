import { describe, it, expect } from "vitest";
import { filterModels } from "./models.ts";

const MODELS = [
	{ provider: "openai", id: "gpt-4o", name: "GPT-4o" },
	{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
];

describe("filterModels", () => {
	it("returns everything for an empty query", () => {
		expect(filterModels(MODELS, "")).toEqual(MODELS);
		expect(filterModels(MODELS, "   ")).toEqual(MODELS);
	});

	it("matches provider, id, or display name case-insensitively", () => {
		expect(filterModels(MODELS, "ANTHROPIC").length).toBe(1);
		expect(filterModels(MODELS, "gpt-4o-mini").length).toBe(1);
		expect(filterModels(MODELS, "sonnet").length).toBe(1);
	});

	it("requires every term to match", () => {
		expect(filterModels(MODELS, "openai mini").length).toBe(1);
		expect(filterModels(MODELS, "openai sonnet").length).toBe(0);
	});

	it("returns an empty list when nothing matches", () => {
		expect(filterModels(MODELS, "zzz-no-such-model")).toEqual([]);
	});
});
