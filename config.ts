/**
 * Configuration persistence for Twiddle extension.
 * Reads/writes a local config.json file in the extension directory.
 */
import { readFile, rename, unlink, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface TwiddleModelRef {
	provider: string;
	id: string;
}

export interface TwiddleConfig {
	/** Selected optimization model */
	model?: TwiddleModelRef;
	/** Token budget threshold percentage (default: 40 = 40% above input) */
	threshold: number;
	/** Auto-mode: optimize every prompt without requiring ~ prefix */
	auto: boolean;
	/** Verbosity level: quiet (errors only) or debug (all details) */
	verbose?: "quiet" | "debug";
	/** Optimization timeout in seconds (default: 15) */
	timeout?: number;
	/** Minimum prompt length (characters) for auto-mode. Default is 0 */
	minChars?: number;
	/** Fallback models tried if primary times out */
	fallbackModels?: TwiddleModelRef[];
}

const CONFIG_FILENAME = "config.json";
const DEFAULT_CONFIG: TwiddleConfig = {
	threshold: 40,
	auto: false,
	verbose: "quiet",
	timeout: 15,
};

function resolveFromExtensionDir(filename: string): string {
	return join(
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
		"extensions",
		"pi-twiddle",
		filename,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validModelRef(value: unknown): value is TwiddleModelRef {
	return isRecord(value) &&
		typeof value.provider === "string" && value.provider.trim().length > 0 &&
		typeof value.id === "string" && value.id.trim().length > 0;
}

function normalizeModel(value: unknown): TwiddleModelRef | undefined {
	if (!validModelRef(value)) return undefined;
	return { provider: value.provider.trim(), id: value.id.trim() };
}

function normalizeModels(value: unknown): TwiddleModelRef[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const models: TwiddleModelRef[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		const model = normalizeModel(item);
		if (!model) continue;
		const ref = `${model.provider}/${model.id}`;
		if (seen.has(ref)) continue;
		seen.add(ref);
		models.push(model);
	}
	return models;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
		? value
		: undefined;
}

export function normalizeConfig(value: unknown): TwiddleConfig {
	const input = isRecord(value) ? value : {};
	const threshold = boundedInteger(input.threshold, 0, 500);
	const timeout = boundedInteger(input.timeout, 5, 60);
	const minChars = boundedInteger(input.minChars, 0, Number.MAX_SAFE_INTEGER);
	const verbose = input.verbose === "quiet" || input.verbose === "debug"
		? input.verbose
		: DEFAULT_CONFIG.verbose;
	const model = normalizeModel(input.model);
	const fallbackModels = normalizeModels(input.fallbackModels);

	return {
		threshold: threshold ?? DEFAULT_CONFIG.threshold,
		auto: typeof input.auto === "boolean" ? input.auto : DEFAULT_CONFIG.auto,
		verbose,
		timeout: timeout ?? DEFAULT_CONFIG.timeout,
		...(model ? { model } : {}),
		...(minChars !== undefined ? { minChars } : {}),
		...(fallbackModels ? { fallbackModels } : {}),
	};
}

export async function readConfig(): Promise<TwiddleConfig> {
	const configPath = resolveFromExtensionDir(CONFIG_FILENAME);
	try {
		const raw = await readFile(configPath, "utf-8");
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

let configCache: TwiddleConfig | null = null;

function cloneConfig(config: TwiddleConfig): TwiddleConfig {
	return normalizeConfig(config);
}

/** Memory-cached config read — eliminates disk I/O on every prompt. */
export async function getConfig(): Promise<TwiddleConfig> {
	if (!configCache) configCache = await readConfig();
	return cloneConfig(configCache);
}

export async function writeConfig(config: TwiddleConfig): Promise<void> {
	const normalized = normalizeConfig(config);
	const configPath = resolveFromExtensionDir(CONFIG_FILENAME);
	await mkdir(dirname(configPath), { recursive: true });
	const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, JSON.stringify(normalized, null, 2), { encoding: "utf-8", mode: 0o600 });
		await rename(tempPath, configPath);
		configCache = cloneConfig(normalized);
	} catch (error) {
		try {
			await unlink(tempPath);
		} catch {
			// Best effort cleanup. Preserve original write error.
		}
		throw error;
	}
}

/** Reset in-memory state so tests and reloads can observe disk contents. */
export function resetConfigCache(): void {
	configCache = null;
}
