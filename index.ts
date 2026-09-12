/**
 * pi-twiddle — prompt optimization extension for pi.
 *
 * Activated via the ~ prefix: ~meu prompt em pt-BR
 * Translates to natural English, structures with Markdown if needed,
 * preserves code/logs/names, and sends the optimized version to the agent.
 *
 * Skill combo: /tdd ~implement the function X
 *   → pi-twiddle extracts the text after ~, optimizes it then passes to the skill.
 *
 * Commands:
 *   /twiddle        — open the control panel (all settings)
 *   /twiddle-model  — select optimization model
 *   /twiddle-threshold — show/set max expansion (0–500%)
 *   /twiddle-reset  — clear config
 *   /twiddle-auto-on     — enable auto-mode (footer: ≈ Twiddle)
 *   /twiddle-auto-off    — disable auto-mode (footer: ~ Twiddle)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { readConfig, getConfig, writeConfig, type TwiddleConfig } from "./config";
import { formatFooterLabel, formatFooterShimmerFrame } from "./footer";
import { optimizePrompt, buildSystemPrompt, detectScope, type Scope } from "./optimizer";
import { detectIntent, type IntentCategory } from "./intent";
import { detectProjectContext, getCachedContext } from "./project";
import { filterModels } from "./models";
import { searchableSelect } from "./picker";
import { decideMissingModelSetup } from "./missing-model-warning";
import {
	applyKnownTransformations,
	applyTextToUserMessage,
	loadAppliedTransformations,
	messageSignature,
	type AppliedTransformation,
} from "./history";

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

interface TwiddleCustomMessage {
	customType: "twiddle";
	content: string;
	display: boolean;
	details: {
		optimizedText: string;
		inputTokens: number;
		outputTokens: number;
		elapsed: string;
		model: string;
		thinkingLevel: string;
	};
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

function pickModelLabel(m: Model<Api>): string {
	return `${m.provider}/${m.id}  (${m.name})`;
}

// ──────────────────────────────────────────────
//  Footer Status
// ──────────────────────────────────────────────

function updateFooterStatus(ctx: any, config: TwiddleConfig): void {
	ctx.ui.setStatus("tw", ctx.ui.theme.fg("dim", formatFooterLabel(config)));
}

// ──────────────────────────────────────────────
//  Verbosity Filter
// ──────────────────────────────────────────────

type NotifyLevel = "quiet" | "debug";

function twiddleNotify(
	ctx: any,
	config: TwiddleConfig,
	level: NotifyLevel,
	message: string,
	severity: "info" | "warning" | "error" = "info",
	suppress?: boolean,
): void {
	if (suppress) return;
	const levels: NotifyLevel[] = ["quiet", "debug"];
	const current = config.verbose ?? "quiet";
	if (levels.indexOf(current) >= levels.indexOf(level)) {
		ctx.ui.notify(message, severity);
	}
}

// ──────────────────────────────────────────────
//  Override Prefix Parsing
// ──────────────────────────────────────────────

const OVERRIDE_PREFIXES: Record<string, IntentCategory | "raw" | undefined> = {
	"bug:": "bug_fix",
	"feature:": "new_feature",
	"refactor:": "refactor",
	"research:": "research",
	"test:": "testing",
	"review:": "review",
	"docs:": "docs",
	"infra:": "infrastructure",
	"design:": "design",
	"raw:": "raw",
};

interface ParsedPrompt {
	/** Clean text (without override prefix) */
	text: string;
	/** Forced intent (if override prefix was used) */
	intent?: IntentCategory;
	/** Skip optimization entirely */
	skipOptimization?: boolean;
	/** Quiet mode — suppress all notifications */
	quiet?: boolean;
}

function parseOverride(rawText: string): ParsedPrompt {
	let text = rawText;
	let quiet = false;

	// Skip optimization: .texto (single dot prefix)
	if (text.startsWith(".")) {
		return { text: text.slice(1).trim(), skipOptimization: true };
	}

	// Quiet mode: !texto or !!texto
	if (text.startsWith("!")) {
		quiet = true;
		text = text.slice(1).trim();
	}

	// Skip optimization: raw:texto
	if (text.startsWith("raw:")) {
		return { text: text.slice(4).trim(), skipOptimization: true, quiet };
	}

	// Intent overrides: bug:texto, feature:texto, etc.
	for (const [prefix, value] of Object.entries(OVERRIDE_PREFIXES)) {
		if (value === "raw") continue; // handled above
		if (text.startsWith(prefix)) {
			return { text: text.slice(prefix.length).trim(), intent: value as IntentCategory, quiet };
		}
	}

	return { text, quiet };
}

// ──────────────────────────────────────────────
//  Fallback Optimization
// ──────────────────────────────────────────────

interface FallbackResult {
	result: Awaited<ReturnType<typeof optimizePrompt>>;
	usedModel: { provider: string; id: string };
	isFallback: boolean;
	attemptIndex: number;
}

async function optimizeWithFallback(
	text: string,
	primary: { provider: string; id: string },
	fallbacks: Array<{ provider: string; id: string }> | undefined,
	pi: ExtensionAPI,
	threshold: number,
	systemPrompt: string,
	timeoutSecs: number,
	signal?: AbortSignal,
): Promise<FallbackResult> {
	// Always attempt optimization — no circuit breaker.
	// Try primary once, then each configured fallback once.
	// Each attempt respects the configured timeout.

	const models = [primary, ...(fallbacks ?? [])];
	let lastError: Error | undefined;

	for (let i = 0; i < models.length; i++) {
		const m = models[i];
		// Explicit cancellation is not a model failure: stop immediately
		// instead of burning time and tokens on fallbacks. Callers keep the
		// user's prompt untouched so Cancel never becomes an accidental send.
		if (signal?.aborted) {
			throw new Error("Optimization cancelled by user.");
		}
		try {
			const execFn = (args: string[]) =>
				pi.exec("pi", args, {
					timeout: timeoutSecs * 1000,
					signal,
				});
			const result = await optimizePrompt(text, m, execFn, threshold, systemPrompt, signal);
			return { result, usedModel: m, isFallback: i > 0, attemptIndex: i + 1 };
		} catch (err) {
			if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
				throw new Error("Optimization cancelled by user.");
			}
			lastError = err instanceof Error ? err : new Error(String(err));
		}
	}

	throw new Error(`All models failed. Last error: ${lastError?.message ?? "unknown"}`);
}

// ──────────────────────────────────────────────
//  Extension
// ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── State ──────────────────────────────────
	// Config is always read from disk to avoid stale state after module reloads.

	// Optimization statistics (in-memory, per session)
	const stats = {
		totalOptimizations: 0,
		appliedOptimizations: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalElapsed: 0,
		totalBudgetExceeded: 0,
		fallbackUsed: 0,
	};

	// Last optimization details (for /twiddle-report preview)
	let lastOptimization: {
		text: string;
		intent?: string;
		scope: string;
		inputTokens: number;
		outputTokens: number;
		elapsed: string;
	} | null = null;

	// ── Animation State ───────────────────────────
	let animTimer: ReturnType<typeof setInterval> | null = null;
	let animFrame = 0;

	function startTwiddleAnim(ctx: any, config: TwiddleConfig) {
		if (animTimer) return;
		animFrame = 0;
		const step = () => {
			ctx.ui.setStatus("tw", formatFooterShimmerFrame(config, animFrame, ctx.ui.theme));
			animFrame++;
		};
		step();
		animTimer = setInterval(step, 160);
	}

	function stopTwiddleAnim(ctx: any, config: TwiddleConfig) {
		if (animTimer) {
			clearInterval(animTimer);
			animTimer = null;
		}
		animFrame = 0;
		updateFooterStatus(ctx, config);
	}

	// ── Session Start: Project Context Detection ──
	pi.on("session_start", async (_event, ctx) => {
		pendingOptimization = null;
		pendingBypass = null;
		try {
			appliedTransformations = loadAppliedTransformations((ctx as any).sessionManager);
		} catch {
			appliedTransformations = [];
			// Ephemeral sessions or entries without comparison records.
		}
		pendingCommandSkips = 0;
		try {
			const workspaceRoot = (ctx as { cwd?: string }).cwd ?? process.cwd();
			await detectProjectContext(workspaceRoot);
		} catch {
			// Project detection failed — optimization will run without context.
		}
		const config = await getConfig();
		updateFooterStatus(ctx, config);
	});

	pi.on("session_shutdown", async () => {
		if (animTimer) {
			clearInterval(animTimer);
			animTimer = null;
		}
		animFrame = 0;
	});

	// ── Message Renderer ───────────────────────
	pi.registerMessageRenderer("twiddle", (message, _options, theme) => {
		return new Text(theme.fg("muted", (message as any).content ?? ""), 0, 0);
	});

	// Comparison record: original vs applied text plus run metadata. Custom
	// entries do NOT participate in LLM context, so the comparison stays
	// visible in the session (collapsed) without polluting model context.
	// The applied version is the single source of truth for what the agent
	// received; the original is kept for audit and resume.
	pi.registerEntryRenderer("twiddle-comparison", (entry, options, theme) => {
		const data = (entry as any).data ?? {};
		const summary = theme.fg("muted",
			`Twiddle: ${data.scope ?? "?"} ${data.inputTokens ?? "?"}→${data.outputTokens ?? "?"} tokens · ${data.model ?? "unknown model"} · ${data.elapsed ?? "?"}s`,
		);
		if ((options as any)?.expanded) {
			return new Text(
				`${summary}\nOriginal: ${data.original ?? ""}\nApplied: ${data.applied ?? ""}`,
				0,
				0,
			);
		}
		return new Text(summary, 0, 0);
	});

	function recordComparison(data: Record<string, unknown>): void {
		try {
			(pi as any).appendEntry?.("twiddle-comparison", data);
		} catch {
		// Ephemeral sessions or older harness without appendEntry.
		}
	}

	// ── Commands ───────────────────────────────

	// Shared model picker used by /twiddle-model, the /twiddle panel, and
	// setup. Returns true when a model was selected and saved.
	async function pickOptimizationModel(ctx: any, config: TwiddleConfig): Promise<boolean> {
		const all = ctx.modelRegistry.getAvailable();

		if (all.length === 0) {
			ctx.ui.notify(
				"No models available. Configure an API key first (/login).",
				"warning",
			);
			return false;
		}

		const options = all.map((m: Model<Api>) => pickModelLabel(m));
		const choice = await searchableSelect(ctx, "Select optimization model:", options);

		if (choice === undefined) return false;
		const idx = options.indexOf(choice);
		const selected = all[idx];
		config.model = { provider: selected.provider, id: selected.id };
		await writeConfig(config);
		updateFooterStatus(ctx, config);
		ctx.ui.notify(`Twiddle model: ${pickModelLabel(selected)}`, "info");
		return true;
	}

	// ── Control Panel ──────────────────────────────────
	// Single entry point for all Twiddle settings. Re-reads config every
	// iteration so the menu never shows stale values.
	async function runControlPanel(ctx: any): Promise<void> {
		// Loop until user exits
		while (true) {
			const config = await getConfig();
			const fallbacks = config.fallbackModels ?? [];
			const fallbackList =
				fallbacks.length > 0
					? fallbacks.map((m) => `${m.provider}/${m.id}`).join(", ")
					: "none";

			const minCharsLabel = typeof config.minChars === "number"
				? `${config.minChars} chars`
				: "0 chars (default)";
			const options = [
				`Model: ${config.model ? `${config.model.provider}/${config.model.id}` : "not set"}`,
				`Expansion limit: ${config.threshold ?? 40}%`,
				`Timeout: ${config.timeout ?? 15}s`,
				`Auto-mode minimum: ${minCharsLabel}`,
				`Verbosity: ${config.verbose ?? "quiet"}`,
				`Auto-mode: ${config.auto ? "ON" : "OFF"}`,
				`Fallbacks: ${fallbackList}`,
				"Exit",
			];

			const choice = await ctx.ui.select("Twiddle — select an option to change:", options);
			if (choice === undefined || choice === "Exit") return;

			const idx = options.indexOf(choice);

			switch (idx) {
				case 0: { // Model
					const all = ctx.modelRegistry.getAvailable();
					if (all.length === 0) {
						ctx.ui.notify("No models available. Configure an API key first.", "warning");
						break;
					}
					const modelOptions = all.map((m) => `${m.provider}/${m.id}  (${m.name})`);
					const pick = await searchableSelect(ctx, "Select optimization model:", modelOptions);
					if (pick !== undefined) {
						const mi = modelOptions.indexOf(pick);
						const selected = all[mi];
						config.model = { provider: selected.provider, id: selected.id };
						await writeConfig(config);
						updateFooterStatus(ctx, config);
					}
					break;
				}
				case 1: { // Threshold
					const val = Number.parseInt(
						await ctx.ui.input("New threshold (0-500):") ?? "",
						10,
					);
					if (!Number.isNaN(val) && val >= 0 && val <= 500) {
						config.threshold = val;
						await writeConfig(config);
					}
					break;
				}
				case 2: { // Timeout
					const val = Number.parseInt(
						await ctx.ui.input("New timeout in seconds (5-60):") ?? "",
						10,
					);
					if (!Number.isNaN(val) && val >= 5 && val <= 60) {
						config.timeout = val;
						await writeConfig(config);
					}
					break;
				}
				case 3: { // Auto-mode minimum
					const raw = await ctx.ui.input("Minimum prompt length for auto-mode in chars (empty = default 0):") ?? "";
					if (raw.trim() === "") {
						config.minChars = undefined;
						await writeConfig(config);
					} else {
						const val = Number.parseInt(raw, 10);
						if (!Number.isNaN(val) && val >= 0) {
							config.minChars = val;
							await writeConfig(config);
						}
					}
					break;
				}
				case 4: { // Verbosity
					const levels = ["quiet", "debug"];
					const current = config.verbose ?? "quiet";
					const next = levels[(levels.indexOf(current) + 1) % levels.length];
					config.verbose = next as "quiet" | "debug";
					await writeConfig(config);
					break;
				}
				case 5: { // Auto-mode
					config.auto = !config.auto;
					await writeConfig(config);
					updateFooterStatus(ctx, config);
					break;
				}
				case 6: { // Fallbacks
					const fbOptions = [
						"Add fallback",
						"Remove fallback",
						"Clear all fallbacks",
						"Back",
					];
					const fbChoice = await ctx.ui.select("Manage fallback models:", fbOptions);
					if (fbChoice === "Add fallback") {
						const all = ctx.modelRegistry.getAvailable();
						if (all.length === 0) {
							ctx.ui.notify("No models available.", "warning");
						} else {
							const existingRefs = new Set(fallbacks.map((m) => `${m.provider}/${m.id}`));
							if (config.model) existingRefs.add(`${config.model.provider}/${config.model.id}`);
							const available = all.filter((m) => !existingRefs.has(`${m.provider}/${m.id}`));
							if (available.length === 0) {
								ctx.ui.notify("All available models already configured.", "info");
							} else {
								const opts = available.map((m) => `${m.provider}/${m.id}  (${m.name})`);
								opts.push("Cancel");
								const pick = await searchableSelect(ctx, "Select fallback model:", opts);
								if (pick !== undefined && pick !== "Cancel") {
									const mi = opts.indexOf(pick);
									const sel = available[mi];
									fallbacks.push({ provider: sel.provider, id: sel.id });
									config.fallbackModels = fallbacks;
									await writeConfig(config);
								}
							}
						}
					} else if (fbChoice === "Remove fallback") {
						if (fallbacks.length > 0) {
							const fbLabels = fallbacks.map((m) => `${m.provider}/${m.id}`);
							fbLabels.push("Cancel");
							const toRemove = await searchableSelect(ctx, "Remove which fallback?", fbLabels);
							if (toRemove && toRemove !== "Cancel") {
								config.fallbackModels = fallbacks.filter(
									(m) => `${m.provider}/${m.id}` !== toRemove,
								);
								await writeConfig(config);
							}
						}
					} else if (fbChoice === "Clear all fallbacks") {
						config.fallbackModels = [];
						await writeConfig(config);
					}
					break;
				}

			}
		}
	}

	pi.registerCommand("twiddle", {
		description: "Twiddle: open the control panel",
		handler: async (_args, ctx) => {
			await runControlPanel(ctx);
		},
	});

	pi.registerCommand("twiddle-model", {
		description: "Twiddle: select optimization model (optional filter text)",
		handler: async (args, ctx) => {
			const config = await getConfig();
			const all = ctx.modelRegistry.getAvailable();

			if (all.length === 0) {
				ctx.ui.notify(
					"No models available. Configure an API key first (/login).",
					"warning",
				);
				return;
			}

			// Optional typed filter: /twiddle-model <text> narrows the catalog
			// by provider, id, or name before showing the selector.
			const query = (args ?? "").trim();
			if (query) {
				const candidates = filterModels(all, query);
				if (candidates.length === 0) {
					ctx.ui.notify(`No models match "${args}".`, "info");
					return;
				}
				if (candidates.length === 1) {
					const selected = candidates[0];
					config.model = { provider: selected.provider, id: selected.id };
					await writeConfig(config);
					updateFooterStatus(ctx, config);
					ctx.ui.notify(`Twiddle model: ${pickModelLabel(selected)}`, "info");
					return;
				}
				// Multiple matches: fall through to the full picker below.
				// (Filtering the picker list itself stays a future refinement.)
			}

			await pickOptimizationModel(ctx, config);
		},
	});

	pi.registerCommand("twiddle-threshold", {
		description: "Twiddle: show or set max expansion of optimized text (0–500%)",
		handler: async (args, ctx) => {
			const config = await getConfig();

			if (!args) {
				ctx.ui.notify(
					`Current expansion limit: ${config.threshold ?? 40}%. Optimized text longer than input + limit is discarded and the original is sent. Use /twiddle-threshold <N> to change (ex: /twiddle-threshold 40).`,
					"info",
				);
				return;
			}

			const val = Number.parseInt(args, 10);
			if (Number.isNaN(val) || val < 0 || val > 500) {
				ctx.ui.notify("Expansion limit must be between 0 and 500.", "error");
				return;
			}
			config.threshold = val;
			await writeConfig(config);
			ctx.ui.notify(
				`Twiddle expansion limit set to ${val}% (optimized text may be ${val}% longer than input at most).`,
				"info",
			);
		},
	});

	pi.registerCommand("twiddle-min-chars", {
		description: "Twiddle: show or set minimum prompt length for auto-mode (chars)",
		handler: async (args, ctx) => {
			const config = await getConfig();
			const current = typeof config.minChars === "number"
				? `${config.minChars} chars`
				: "0 chars (default — every prompt eligible)";

			if (!args) {
				ctx.ui.notify(
					`Current auto-mode minimum: ${current}. Shorter auto-mode prompts are sent unchanged; ~ always optimizes. Use /twiddle-min-chars <N> to set, or /twiddle-min-chars off to restore the default.`,
					"info",
				);
				return;
			}

			if (args.toLowerCase().trim() === "off") {
				config.minChars = undefined;
				await writeConfig(config);
				ctx.ui.notify("Auto-mode minimum restored to the default (0 — every prompt eligible).", "info");
				return;
			}

			const val = Number.parseInt(args, 10);
			if (Number.isNaN(val) || val < 0) {
				ctx.ui.notify("Minimum must be 0 or more characters, or off.", "error");
				return;
			}
			config.minChars = val;
			await writeConfig(config);
			ctx.ui.notify(
				val === 0
					? "Auto-mode minimum disabled: length alone no longer skips optimization."
					: `Auto-mode minimum set to ${val} chars. Shorter auto-mode prompts are sent unchanged; ~ always optimizes.`,
				"info",
				);
		},
	});

	pi.registerCommand("twiddle-reset", {
		description: "Twiddle: reset config to defaults",
		handler: async (_args, ctx) => {
			await writeConfig({ threshold: 40, auto: false });
			const config = await getConfig();
			updateFooterStatus(ctx, config);
			ctx.ui.notify("Twiddle config reset to defaults (model and fallbacks cleared).", "info");
		},
	});

	pi.registerCommand("twiddle-auto-on", {
		description: "Twiddle: enable auto-mode (footer: ≈ Twiddle)",
		handler: async (_args, ctx) => {
			const config = await getConfig();
			config.auto = true;
			await writeConfig(config);
			updateFooterStatus(ctx, config);
			ctx.ui.notify("auto-mode ON — eligible prompts are optimized.", "info");
		},
	});

	pi.registerCommand("twiddle-auto-off", {
		description: "Twiddle: disable auto-mode (footer: ~ Twiddle)",
		handler: async (_args, ctx) => {
			const config = await getConfig();
			config.auto = false;
			await writeConfig(config);
			updateFooterStatus(ctx, config);
			ctx.ui.notify("auto-mode OFF — use ~ prefix to optimize.", "info");
		},
	});

	pi.registerCommand("twiddle-report", {
		description: "Twiddle: show optimization statistics for this session",
		handler: async (_args, ctx) => {
			if (stats.totalOptimizations === 0) {
				ctx.ui.notify("No optimizations yet this session.", "info");
				return;
			}
			const avgRatio =
				stats.totalInputTokens > 0
					? ((stats.totalOutputTokens / stats.totalInputTokens) * 100).toFixed(0)
					: "0";
			const fallbackNote =
				stats.fallbackUsed > 0
					? ` · ${stats.fallbackUsed} via fallback`
					: "";
			const summary = `Twiddle Report: ${stats.totalOptimizations} attempts · ` +
				`${stats.appliedOptimizations} applied · ` +
				`${stats.totalBudgetExceeded} rejected over expansion limit · ` +
				`~${stats.totalInputTokens}→~${stats.totalOutputTokens} est. tokens ` +
				`(avg ${avgRatio}%) · ` +
				`${stats.totalElapsed.toFixed(0)}s total` +
				fallbackNote;
			ctx.ui.notify(summary, "info");

			// Show last optimization preview
			if (lastOptimization) {
				const lo = lastOptimization;
				const intentLabel = lo.intent ? ` | 🎯 ${lo.intent}` : "";
				const header = `Last applied: 📐 ${lo.scope}${intentLabel} | 🧾 ~${lo.inputTokens}→~${lo.outputTokens} est. tokens ⏳ ${lo.elapsed}s | full comparison stored in the session entry`;
				ctx.ui.notify(header, "info");
				ctx.ui.notify(lo.text, "info");
			}
		},
	});

	pi.registerCommand("twiddle-verbose", {
		description: "Twiddle: set verbosity level (quiet, debug)",
		handler: async (args, ctx) => {
			const config = await getConfig();
			const current = config.verbose ?? "quiet";

			if (!args) {
				ctx.ui.notify(`Current verbosity: ${current}. Use /twiddle-verbose <quiet|debug>.`, "info");
				return;
			}

			const level = args.toLowerCase().trim();
			if (level !== "quiet" && level !== "debug") {
				ctx.ui.notify("Use: quiet or debug.", "error");
				return;
			}

			config.verbose = level as "quiet" | "debug";
			await writeConfig(config);
			ctx.ui.notify(`Twiddle verbosity: ${level}.`, "info");
		},
	});

	pi.registerCommand("twiddle-timeout", {
		description: "Twiddle: set optimization timeout in seconds (default: 15)",
		handler: async (args, ctx) => {
			const config = await getConfig();

			if (!args) {
				ctx.ui.notify(
					`Current timeout: ${config.timeout ?? 15}s. Use /twiddle-timeout <N> (5-60).`,
					"info",
				);
				return;
			}

			const val = Number.parseInt(args, 10);
			if (Number.isNaN(val) || val < 5 || val > 60) {
				ctx.ui.notify("Timeout must be between 5 and 60 seconds.", "error");
				return;
			}
			config.timeout = val;
			await writeConfig(config);
			ctx.ui.notify(`Twiddle timeout set to ${val}s.`, "info");
		},
	});

	pi.registerCommand("twiddle-fallback", {
		description: "Twiddle: manage fallback models (add, remove, list, clear)",
		handler: async (args, ctx) => {
			const config = await getConfig();
			const fallbacks = config.fallbackModels ?? [];

			if (!args) {
				if (fallbacks.length === 0) {
					ctx.ui.notify("No fallback models configured. Use /twiddle-fallback add <provider/id>.", "info");
				} else {
					const list = fallbacks.map((m, i) => `${i + 1}. ${m.provider}/${m.id}`).join(" · ");
					ctx.ui.notify(`Fallbacks (${fallbacks.length}): ${list}`, "info");
				}
				return;
			}

			const parts = args.split(/\s+/);
			const action = parts[0].toLowerCase();

			if (action === "list") {
				if (fallbacks.length === 0) {
					ctx.ui.notify("No fallback models configured. Use /twiddle-fallback add to pick one.", "info");
				} else {
					const list = fallbacks.map((m, i) => `${i + 1}. ${m.provider}/${m.id}`).join(" · ");
					ctx.ui.notify(`Fallbacks (${fallbacks.length}): ${list}`, "info");
				}
				return;
			}

			if (action === "clear") {
				config.fallbackModels = [];
				await writeConfig(config);
				ctx.ui.notify("All fallback models cleared.", "info");
				return;
			}

			if (action === "add") {
				// Show model selector instead of free-text input
				const all = ctx.modelRegistry.getAvailable();
				if (all.length === 0) {
					ctx.ui.notify("No models available. Configure an API key first.", "warning");
					return;
				}
				const existingRefs = new Set(fallbacks.map((m) => `${m.provider}/${m.id}`));
				if (config.model) existingRefs.add(`${config.model.provider}/${config.model.id}`);
				const available = all.filter(
					(m) => !existingRefs.has(`${m.provider}/${m.id}`),
				);
				if (available.length === 0) {
					ctx.ui.notify("All available models are already configured (primary or fallback).", "info");
					return;
				}
				const options = available.map((m) => `${m.provider}/${m.id}  (${m.name})`);
				options.push("Cancel");
				const pick = await searchableSelect(ctx, "Select fallback model:", options);
				if (pick !== undefined && pick !== "Cancel") {
					const idx = options.indexOf(pick);
					const selected = available[idx];
					fallbacks.push({ provider: selected.provider, id: selected.id });
					config.fallbackModels = fallbacks;
					await writeConfig(config);
					ctx.ui.notify(`Fallback added: ${selected.provider}/${selected.id}.`, "info");
				}
				return;
			}

			if (action === "remove" && parts[1]) {
				const ref = parts[1];
				const idx = fallbacks.findIndex((m) => `${m.provider}/${m.id}` === ref);
				if (idx === -1) {
					ctx.ui.notify(`Fallback not found: ${ref}.`, "error");
					return;
				}
				fallbacks.splice(idx, 1);
				config.fallbackModels = fallbacks;
				await writeConfig(config);
				ctx.ui.notify(`Fallback removed: ${ref}.`, "info");
				return;
			}

			ctx.ui.notify("Use: /twiddle-fallback [add|remove|list|clear].", "error");
		},
	});

	// ── Shared Optimization Core ──────────────
	// Common logic for both the input event (commands) and the context event
	// (plain prompts). Callers handle UI output and message transformation.

	interface OptimizationRequest {
		effectiveText: string;
		forcedIntent?: IntentCategory;
		model: { provider: string; id: string };
		fallbackModels?: Array<{ provider: string; id: string }>;
		threshold: number;
		timeoutSeconds: number;
		startTime: number;
	}

	interface OptimizationCoreResult {
		fr: FallbackResult;
		elapsed: string;
		intent: IntentCategory | undefined;
		scope: Scope;
	}

	async function runOptimizationCore(
		req: OptimizationRequest,
		ctx: any,
		config: TwiddleConfig,
	): Promise<OptimizationCoreResult> {
		const intent = req.forcedIntent ?? detectIntent(req.effectiveText);
		const workspaceRoot = (ctx as { cwd?: string }).cwd ?? process.cwd();
		const projectContext = getCachedContext(workspaceRoot);
		const thinkingLevel = pi.getThinkingLevel();
		const scope = detectScope(req.effectiveText);
		const systemPrompt = buildSystemPrompt({
			intent,
			projectContext: projectContext ?? undefined,
			thinkingLevel,
			scope,
		});

		// Count request before provider execution so exhausted chains remain visible.
		stats.totalOptimizations++;
		startTwiddleAnim(ctx, config);
		const fr = await optimizeWithFallback(
			req.effectiveText,
			req.model,
			req.fallbackModels,
			pi,
			req.threshold,
			systemPrompt,
			req.timeoutSeconds,
			ctx.signal ?? undefined,
		);
		stopTwiddleAnim(ctx, config);

		const elapsed = ((Date.now() - req.startTime) / 1000).toFixed(1);

		stats.totalInputTokens += fr.result.inputTokens;
		stats.totalOutputTokens += fr.result.outputTokens;
		stats.totalElapsed += parseFloat(elapsed);
		if (fr.isFallback) {
			stats.fallbackUsed++;
		}
		if (fr.result.exceedsBudget) {
			stats.totalBudgetExceeded++;
		} else {
			stats.appliedOptimizations++;
			lastOptimization = {
				text: fr.result.optimizedText,
				intent,
				scope,
				inputTokens: fr.result.inputTokens,
				outputTokens: fr.result.outputTokens,
				elapsed,
			};
		}

		return { fr, elapsed, intent, scope };
	}

	// ── Error Report Helper ────────────────────
	function buildModelChain(
		primaryModel: { provider: string; id: string } | undefined,
		fallbackModels: Array<{ provider: string; id: string }> | undefined,
	): string {
		const primary = primaryModel ? `${primaryModel.provider}/${primaryModel.id}` : "no model";
		const fallbacks = (fallbackModels ?? []).map((m) => `${m.provider}/${m.id}`);
		return [primary, ...fallbacks].join(" → ");
	}

	// ── State ──────────────────────────────────
	// Number of command inputs awaiting before_agent_start. A counter avoids
	// stale boolean state when several prompts are queued during streaming.
	let pendingCommandSkips = 0;
	let missingModelSetupSilencedForSession = false;

	async function ensureModelConfigured(text: string, ctx: any, config: TwiddleConfig): Promise<boolean> {
		const decision = decideMissingModelSetup(text, {
			hasModel: Boolean(config.model),
			sessionSilenced: missingModelSetupSilencedForSession,
		});
		if (!decision.missingModel) return true;
		if (!decision.shouldPrompt) return false;

		const models = ctx.modelRegistry.getAvailable();
		if (models.length === 0) {
			missingModelSetupSilencedForSession = true;
			twiddleNotify(ctx, config, "debug",
				"Twiddle: no models available. Configure an API key first. Prompts will be sent unchanged this session.",
				"warning",
			);
			return false;
		}

		const options = models.map((model: Model<Api>) => pickModelLabel(model));
		options.push("Cancel");
		const choice = await searchableSelect(ctx, "Twiddle needs an optimization model:", options);
		if (choice === undefined || choice === "Cancel") {
			missingModelSetupSilencedForSession = true;
			twiddleNotify(ctx, config, "debug",
				"Twiddle: no model selected. Prompts will be sent unchanged this session. Use /twiddle-model to enable optimization.",
				"warning",
			);
			return false;
		}

		const selected = models[options.indexOf(choice)];
		config.model = { provider: selected.provider, id: selected.id };
		await writeConfig(config);
		updateFooterStatus(ctx, config);
		twiddleNotify(ctx, config, "debug", `Twiddle model: ${pickModelLabel(selected)}`);
		return true;
	}

	// ── Input Event ────────────────────────────
	// Intercepta /command ~texto ANTES da expansão de skills.
	// Extrai o texto após ~, otimiza, e reconstroi o comando.
	pi.on("input", async (event, ctx) => {
		const config = await getConfig();
		const text = event.text;

		if (!text.startsWith("/")) return; // not a command, let before_agent_start handle it

		const tildeIdx = text.indexOf(" ~");

		if (tildeIdx === -1) {
			// Command prompts must not be auto-optimized after skill/template expansion.
			if (config.auto) pendingCommandSkips++;
			return; // continue — passes through intact
		}

		// Parse control syntax before model setup so raw bypasses remain usable
		// even when no optimization model is configured.
		const commandPrefix = text.slice(0, tildeIdx).trimEnd();
		const rawText = text.slice(tildeIdx + 2).trim();
		if (!rawText) return;
		const parsed = parseOverride(rawText);
		const effectiveText = parsed.text;
		if (parsed.skipOptimization) {
			pendingCommandSkips++;
			return { action: "transform", text: `${commandPrefix} ${effectiveText}` };
		}

		pendingCommandSkips++;
		const hasModel = await ensureModelConfigured(text, ctx, config);
		if (!hasModel || !config.model) return;

		const startTime = Date.now();

		try {
			const { fr, elapsed } = await runOptimizationCore({
				effectiveText,
				forcedIntent: parsed.intent,
				model: config.model,
				fallbackModels: config.fallbackModels,
				threshold: config.threshold ?? 40,
				timeoutSeconds: config.timeout ?? 15,
				startTime,
			}, ctx, config);

			const verbose = config.verbose ?? "quiet";
			if (!parsed.quiet && verbose !== "quiet") {
				const totalModels = 1 + (config.fallbackModels?.length ?? 0);
				ctx.ui.notify(
					`Twiddle~ 🧠 ${fr.usedModel.provider}/${fr.usedModel.id} 🧩 ${fr.result.inputTokens}->${fr.result.outputTokens} ⏳ ${elapsed}s - try ${fr.attemptIndex}/${totalModels}`,
					"info",
				);
			}

			if (fr.result.exceedsBudget) {
				twiddleNotify(ctx, config, "quiet",
					`Twiddle: optimization exceeded budget (${fr.result.inputTokens} → ${fr.result.outputTokens}). Sending original.`,
					"warning",
				);
				// Still strip the control syntax so the agent never sees `~`.
				return { action: "transform", text: `${commandPrefix} ${effectiveText}` };
			}

			if (!parsed.quiet && verbose === "debug") {
				ctx.ui.notify(fr.result.optimizedText, "info");
			}

			recordComparison({
				original: text,
				applied: `${commandPrefix} ${fr.result.optimizedText}`,
				model: `${fr.usedModel.provider}/${fr.usedModel.id}`,
				inputTokens: fr.result.inputTokens,
				outputTokens: fr.result.outputTokens,
				elapsed,
				scope: detectScope(effectiveText),
				exceedsBudget: fr.result.exceedsBudget,
			});
			return { action: "transform", text: `${commandPrefix} ${fr.result.optimizedText}` };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			stats.totalElapsed += parseFloat(elapsed);
			stopTwiddleAnim(ctx, config);
			twiddleNotify(ctx, config, "quiet", `Twiddle: error — sending original. ${message}`, "warning");
			return;
		}
	});

	// before_agent_start + context para prompts sem comando (~texto).
	// Para comandos, o input event (acima) faz o trabalho.

	let pendingOptimization: {
		rawPrompt: string;
		effectiveText: string;
		model: { provider: string; id: string };
		fallbackModels?: Array<{ provider: string; id: string }>;
		startTime: number;
		threshold: number;
		mode: "auto" | "~";
		forcedIntent?: IntentCategory;
		quiet?: boolean;
		verbose?: string;
		timeoutSeconds?: number;
	} | null = null;

	// Bypass without LLM: strip Twiddle control syntax and forward clean text.
	let pendingBypass: { rawPrompt: string; stripped: string } | null = null;

	// Context events transform copies. Keep every applied mapping so subsequent
	// model calls and resumed sessions see the same text for every user message.
	let appliedTransformations: AppliedTransformation[] = [];

	pi.on("before_agent_start", async (event, ctx) => {
		// Input event already handled a command (or protected it from auto-mode).
		if (pendingCommandSkips > 0) {
			pendingCommandSkips--;
			return;
		}

		const config = await getConfig();

		const trimmed = event.prompt.trim();
		const hasPrefix = trimmed.startsWith("~");

		// Auto-mode ON: process every prompt
		// Auto-mode OFF: only process prompts with ~ prefix
		if (!config.auto && !hasPrefix) return;

		// Strip ~ prefix if present
		const rawPrompt = hasPrefix ? trimmed.slice(1).trim() : trimmed;
		if (!rawPrompt) return;

		// Auto-mode length filter (plain prompts only; `~` always bypasses it).
		// Default minimum is 0: every auto-mode prompt is eligible.
		if (config.auto && !hasPrefix) {
			const minChars = config.minChars ?? 0;
			if (minChars > 0 && rawPrompt.length < minChars) return;
		}

		// Parse override prefixes (~raw:, ~bug:, ~~, etc.)
		const parsed = parseOverride(rawPrompt);
		if (parsed.skipOptimization) {
			// ~raw: skip the LLM call but still strip the control syntax so
			// the agent never sees `~raw:` / `~.` prefixes.
			pendingBypass = { rawPrompt: trimmed, stripped: parsed.text };
			return;
		}

		const hasModel = await ensureModelConfigured(event.prompt, ctx, config);
		if (!hasModel || !config.model) return;

		const mode = config.auto ? "auto" : "~";

		pendingOptimization = {
			rawPrompt,
			effectiveText: parsed.text,
			model: config.model,
			fallbackModels: config.fallbackModels,
			startTime: Date.now(),
			threshold: config.threshold ?? 40,
			mode,
			forcedIntent: parsed.intent,
			quiet: parsed.quiet,
			verbose: config.verbose ?? "quiet",
			timeoutSeconds: config.timeout ?? 15,
		};
	});

	pi.on("context", async (event, ctx) => {
		if (pendingBypass) {
			const { stripped } = pendingBypass;
			pendingBypass = null;
			const messages = [...event.messages];
			applyKnownTransformations(messages, appliedTransformations, true);
			let userMsgIdx = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "user") {
					userMsgIdx = i;
					break;
				}
			}
			if (userMsgIdx >= 0) {
				const signature = messageSignature(messages[userMsgIdx]);
				messages[userMsgIdx] = applyTextToUserMessage(messages[userMsgIdx], stripped) as never;
				if (signature !== null) {
					appliedTransformations.push({ original: signature, applied: stripped });
				}
			}
			return { messages };
		}

		if (pendingOptimization) {
		const {
			effectiveText,
			model: modelRef,
			fallbackModels,
			startTime,
			threshold,
			forcedIntent,
			quiet,
			verbose,
			timeoutSeconds,
		} = pendingOptimization;
		pendingOptimization = null;

		const config = await getConfig();
		const messages = [...event.messages];
		applyKnownTransformations(messages, appliedTransformations, true);

		try {
			const { fr, elapsed, intent, scope } = await runOptimizationCore({
				effectiveText,
				forcedIntent,
				model: modelRef,
				fallbackModels,
				threshold,
				timeoutSeconds: timeoutSeconds ?? 15,
				startTime,
			}, ctx, config);

			let userMsgIdx = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "user") {
					userMsgIdx = i;
					break;
				}
			}

			if (!fr.result.exceedsBudget && userMsgIdx >= 0) {
				const signature = messageSignature(messages[userMsgIdx]);
				messages[userMsgIdx] = applyTextToUserMessage(
					messages[userMsgIdx],
					fr.result.optimizedText,
				) as never;
				if (signature !== null) {
					appliedTransformations.push({ original: signature, applied: fr.result.optimizedText });
				}
				recordComparison({
					original: signature ?? effectiveText,
					applied: fr.result.optimizedText,
					model: `${fr.usedModel.provider}/${fr.usedModel.id}`,
					inputTokens: fr.result.inputTokens,
					outputTokens: fr.result.outputTokens,
					elapsed,
					intent: intent ?? null,
					scope,
					exceedsBudget: false,
				});
			}

			if (!quiet && verbose !== "quiet") {
				const totalModels = 1 + (fallbackModels?.length ?? 0);
				ctx.ui.notify(
					`Twiddle~ 🧠 ${fr.usedModel.provider}/${fr.usedModel.id} 🧩 ${fr.result.inputTokens}->${fr.result.outputTokens} ⏳ ${elapsed}s - try ${fr.attemptIndex}/${totalModels}`,
					"info",
				);
			}
			if (!quiet && verbose === "debug" && !fr.result.exceedsBudget) {
				ctx.ui.notify(fr.result.optimizedText, "info");
			}

			return { messages };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			stats.totalElapsed += parseFloat(elapsed);
			stopTwiddleAnim(ctx, config);
			ctx.ui.notify(`⚠️ Twiddle: ${buildModelChain(modelRef, fallbackModels)} | all failed in ${elapsed}s | ${message}`, "warning");
			return { messages };
		}
		}

		if (appliedTransformations.length > 0) {
			const messages = [...event.messages];
			applyKnownTransformations(messages, appliedTransformations, false);
			return { messages };
		}
		return;
	});
}
