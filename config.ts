/**
 * Configuration persistence for Twiddle extension.
 * Reads/writes a local config.json file in the extension directory.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface TwiddleConfig {
	/** Selected optimization model */
	model?: {
		provider: string;
		id: string;
	};
	/** Token budget threshold percentage (default: 40 = 40% above input) */
	threshold: number;
	/** Auto-mode: optimize every prompt without requiring ~ prefix */
	auto: boolean;
	/** Verbosity level: quiet (errors only), normal (consolidated), debug (everything) */
	verbose?: "quiet" | "normal" | "debug";
	/** Optimization timeout in seconds (default: 15) */
	timeout?: number;
	/** Fallback models tried if primary times out */
	fallbackModels?: Array<{ provider: string; id: string }>;
	/** Fast model for trivial/low scope prompts (optional) */
	quickModel?: { provider: string; id: string };
}

const CONFIG_FILENAME = "config.json";

function resolveFromExtensionDir(filename: string): string {
	return join(
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
		"extensions",
		"pi-twiddle",
		filename,
	);
}

export async function readConfig(): Promise<TwiddleConfig> {
	const configPath = resolveFromExtensionDir(CONFIG_FILENAME);
	try {
		const raw = await readFile(configPath, "utf-8");
		return JSON.parse(raw) as TwiddleConfig;
	} catch {
		return { threshold: 40, auto: false, verbose: "normal", timeout: 15 };
	}
}

let configCache: TwiddleConfig | null = null;

/** Memory-cached config read — eliminates disk I/O on every prompt. */
export async function getConfig(): Promise<TwiddleConfig> {
	if (configCache) return configCache;
	configCache = await readConfig();
	return configCache;
}

export async function writeConfig(config: TwiddleConfig): Promise<void> {
	configCache = config; // optimistic: update cache before disk write
	const configPath = resolveFromExtensionDir(CONFIG_FILENAME);
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}
