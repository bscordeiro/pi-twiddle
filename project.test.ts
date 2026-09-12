import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { detectProjectContext, getCachedContext, resetContext } from "./project.ts";

beforeEach(() => resetContext());

describe("project context cache", () => {
	it("keeps contexts isolated by workspace root", async () => {
		await mkdir("/tmp/pi-twiddle-js", { recursive: true });
		await mkdir("/tmp/pi-twiddle-rust", { recursive: true });
		await writeFile("/tmp/pi-twiddle-js/package.json", "{}", "utf8");
		await writeFile("/tmp/pi-twiddle-rust/Cargo.toml", "[package]\nname = 'synthetic'", "utf8");

		expect((await detectProjectContext("/tmp/pi-twiddle-js"))?.language).toBe("JavaScript");
		expect((await detectProjectContext("/tmp/pi-twiddle-rust"))?.language).toBe("Rust");
		expect(getCachedContext("/tmp/pi-twiddle-rust")?.language).toBe("Rust");
	});
});
