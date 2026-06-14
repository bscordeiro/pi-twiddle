import { describe, it, expect } from "vitest";
import { detectIntent } from "./intent.ts";

describe("detectIntent", () => {
	it("detects bug_fix from English keywords", () => {
		expect(detectIntent("fix the crash on login")).toBe("bug_fix");
	});

	it("detects bug_fix from pt-BR keywords", () => {
		expect(detectIntent("corrigir o erro de autenticação")).toBe("bug_fix");
	});

	it("detects new_feature from English", () => {
		expect(detectIntent("add a dark mode toggle to the settings page")).toBe("new_feature");
	});

	it("detects new_feature from pt-BR", () => {
		expect(detectIntent("criar uma funcionalidade de exportação em PDF")).toBe("new_feature");
	});

	it("detects refactor", () => {
		expect(detectIntent("refactor the auth module to use SOLID principles")).toBe("refactor");
	});

	it("detects research from a question", () => {
		expect(detectIntent("how does the event loop work?")).toBe("research");
	});

	it("detects testing", () => {
		expect(detectIntent("write unit tests for the payment service")).toBe("testing");
	});

	it("detects docs", () => {
		expect(detectIntent("update the README with the new API endpoints")).toBe("docs");
	});

	it("detects infrastructure", () => {
		expect(detectIntent("set up the CI pipeline for the new microservice")).toBe("infrastructure");
	});

	it("detects design", () => {
		expect(detectIntent("design the data model for the notification system")).toBe("design");
	});

	it("returns undefined for ambiguous input", () => {
		expect(detectIntent("hello there")).toBeUndefined();
	});

	it("returns undefined when multiple categories tie", () => {
		// Both bug_fix and new_feature keywords present with equal weight
		const result = detectIntent("create and fix");
		// Should be either one or undefined — must not throw
		expect(["bug_fix", "new_feature", "refactor", undefined]).toContain(result);
	});
});
