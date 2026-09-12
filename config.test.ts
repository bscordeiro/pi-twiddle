import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getConfig, normalizeConfig, readConfig, resetConfigCache, writeConfig } from "./config.ts";

const root = "/tmp/pi-twiddle-config-tests";

beforeEach(async () => {
	process.env.PI_CODING_AGENT_DIR = root;
	resetConfigCache();
	await mkdir(`${root}/extensions/pi-twiddle`, { recursive: true });
	await writeFile(`${root}/extensions/pi-twiddle/config.json`, "{}", "utf8");
});

describe("normalizeConfig", () => {
	it("replaces null and invalid values with safe defaults", () => {
		expect(normalizeConfig(null)).toEqual({
			threshold: 40,
			auto: false,
			verbose: "quiet",
			timeout: 15,
		});
		const normalized = normalizeConfig({
			threshold: 999,
			timeout: 1,
			minChars: -2,
			auto: "yes",
			verbose: "normal",
			quickModel: { provider: "openai", id: "gpt-4o-mini" },
		});
		expect(normalized).toMatchObject({ threshold: 40, timeout: 15, auto: false, verbose: "quiet" });
		expect(normalized).not.toHaveProperty("minChars");
		expect(normalized).not.toHaveProperty("quickModel");
	});
});

describe("config persistence", () => {
	it("normalizes valid JSON before returning it", async () => {
		await writeFile(`${root}/extensions/pi-twiddle/config.json`, "null", "utf8");
		expect(await readConfig()).toMatchObject({ threshold: 40, auto: false });
	});

	it("writes through a temporary file and updates cache only after success", async () => {
		await writeConfig({ threshold: 20, auto: true });
		expect(await getConfig()).toMatchObject({ threshold: 20, auto: true });
		expect(JSON.parse(await readFile(`${root}/extensions/pi-twiddle/config.json`, "utf8"))).toMatchObject({
			threshold: 20,
			auto: true,
		});
	});

	it("keeps previous cached config when persistence fails", async () => {
		await writeConfig({ threshold: 20, auto: false });
		const next = await getConfig();
		next.threshold = 30;
		process.env.PI_CODING_AGENT_DIR = "/dev/null";
		await expect(writeConfig(next)).rejects.toThrow();
		process.env.PI_CODING_AGENT_DIR = root;
		expect((await getConfig()).threshold).toBe(20);
	});
});
