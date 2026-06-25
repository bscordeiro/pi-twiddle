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
 *   /twiddle        — show current config
 *   /twiddle-model  — select optimization model
 *   /twiddle-threshold — show/set token budget (0–500%)
 *   /twiddle-reset  — clear config
 *   /twiddle-auto-on     — enable auto-mode (footer: ≈ Twiddle)
 *   /twiddle-auto-off    — disable auto-mode (footer: ~ Twiddle)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { readConfig, getConfig, writeConfig, type TwiddleConfig } from "./config";
import { formatFooterLabel, formatFooterShimmerFrame } from "./footer";
import { optimizePrompt, buildSystemPrompt, detectScope, type Scope } from "./optimizer";
import { detectIntent, type IntentCategory } from "./intent";
import { detectProjectContext, getCachedContext, type ProjectContext } from "./project";
import { decideMissingModelSetup } from "./missing-model-warning";

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

function pickModelLabel(m: Model): string {
	return `${m.provider}/${m.id}  (${m.name})`;
}

function formatModelRef(config: TwiddleConfig): string {
	if (!config.model) return "none (not configured)";
	const { provider, id } = config.model;
	const autoFlag = config.auto ? " auto" : "";
	return `${provider}/${id}${autoFlag}`;
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

type NotifyLevel = "quiet" | "normal" | "debug";

function twiddleNotify(
	ctx: any,
	config: TwiddleConfig,
	level: NotifyLevel,
	message: string,
	severity: "info" | "warning" | "error" = "info",
	suppress?: boolean,
): void {
	if (suppress) return;
	const levels: NotifyLevel[] = ["quiet", "normal", "debug"];
	const current = config.verbose ?? "normal";
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
	scope: string,
	quickModel?: { provider: string; id: string },
	signal?: AbortSignal,
): Promise<FallbackResult> {
	// Always attempt optimization — no circuit breaker.
	// Try primary once, then each configured fallback once.
	// Each attempt respects the configured timeout.

	// Use quick model for trivial/low scope if configured
	const effectivePrimary =
		quickModel && (scope === "trivial" || scope === "low")
			? quickModel
			: primary;

	const models = [effectivePrimary, ...(fallbacks ?? [])];
	let lastError: Error | undefined;

	for (let i = 0; i < models.length; i++) {
		const m = models[i];
		try {
			const execFn = (args: string[]) =>
				pi.exec("pi", args, {
					timeout: timeoutSecs * 1000,
					signal,
				});
			const result = await optimizePrompt(text, m, execFn, threshold, systemPrompt, signal);
			return { result, usedModel: m, isFallback: i > 0, attemptIndex: i + 1 };
		} catch (err) {
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
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalElapsed: 0,
		totalBudgetExceeded: 0,
		shortResponseCount: 0,
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

	// Tool call counter for context pressure
	let toolCallCount = 0;
	const COMPACT_THRESHOLD = 30;

	// Track whether last prompt was optimized (for quality feedback in agent_end)
	let lastPromptWasOptimized = false;

	// ── Animation State ───────────────────────────
	let animTimer: ReturnType<typeof setInterval> | null = null;
	let animFrame = 0;

	function startTwiddleAnim(ctx: any, config: TwiddleConfig) {
		if (animTimer) return;
		animFrame = 0;
		const step = () => {
			ctx.ui.setStatus("tw", formatFooterShimmerFrame(config, animFrame));
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
		toolCallCount = 0;
		try {
			await detectProjectContext(process.cwd());
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

	// ── Context Pressure Indicator ─────────────
	pi.on("tool_call", async (_event, ctx) => {
		toolCallCount++;
		if (toolCallCount === COMPACT_THRESHOLD) {
			ctx.ui.notify(
				`~ ${toolCallCount} tool calls this session. Consider /compact or /clear to free up context.`,
				"warning",
			);
		}
	});

	// ── Quality Feedback (agent_end) ───────────
	pi.on("agent_end", async (event, ctx) => {
		if (!lastPromptWasOptimized) return;

		const lastMsg = event.messages[event.messages.length - 1];
		if (!lastMsg || lastMsg.role !== "assistant") return;

		const responseText =
			typeof lastMsg.content === "string"
				? lastMsg.content
				: Array.isArray(lastMsg.content)
					? lastMsg.content
							.filter((b: any) => b.type === "text")
							.map((b: any) => b.text)
							.join("\n")
					: "";

		if (responseText.length < 120) {
			stats.shortResponseCount++;
		}

		lastPromptWasOptimized = false;
	});

	// ── Message Renderer ───────────────────────
	pi.registerMessageRenderer("twiddle", (message, _options, theme) => {
		return new Text(theme.fg("muted", (message as any).content ?? ""), 0, 0);
	});

	// ── Commands ───────────────────────────────

	pi.registerCommand("twiddle", {
		description: "Twiddle: show current configuration",
		handler: async (_args, ctx) => {
			const config = await getConfig();
			const autoStatus = config.auto ? "auto" : "manual";
			twiddleNotify(ctx, config, "normal",
				`Twiddle  •  ${formatModelRef(config)}  •  threshold: ${config.threshold ?? 40}%  •  timeout: ${config.timeout ?? 15}s  •  verbose: ${config.verbose ?? "normal"}  •  mode: ${autoStatus}`,
			);
		},
	});

	pi.registerCommand("twiddle-model", {
		description: "Twiddle: select optimization model",
		handler: async (_args, ctx) => {
			const config = await getConfig();
			const all = ctx.modelRegistry.getAvailable();

			if (all.length === 0) {
				ctx.ui.notify(
					"No models available. Configure an API key first (/login).",
					"warning",
				);
				return;
			}

			const options = all.map((m) => pickModelLabel(m));
			const choice = await ctx.ui.select("Select optimization model:", options);

			if (choice !== undefined) {
				const idx = options.indexOf(choice);
				const selected = all[idx];
				config.model = { provider: selected.provider, id: selected.id };
				await writeConfig(config);
				updateFooterStatus(ctx, config);
				twiddleNotify(ctx, config, "normal",
					`Twiddle model: ${pickModelLabel(selected)}`,
				);
			}
		},
	});

	pi.registerCommand("twiddle-threshold", {
		description: "Twiddle: show or set token budget threshold (0–500%)",
		handler: async (args, ctx) => {
			const config = await getConfig();

			if (!args) {
				twiddleNotify(ctx, config, "normal",
					`Current threshold: ${config.threshold ?? 40}%. Use /twiddle-threshold <N> to change (ex: /twiddle-threshold 40).`,
				);
				return;
			}

			const val = Number.parseInt(args, 10);
			if (Number.isNaN(val) || val < 0 || val > 500) {
				twiddleNotify(ctx, config, "normal", "Threshold must be between 0 and 500.", "error");
				return;
			}
			config.threshold = val;
			await writeConfig(config);
			twiddleNotify(ctx, config, "normal",
				`Twiddle threshold set to ${val}% (max ${val}% over input).`,
			);
		},
	});

	pi.registerCommand("twiddle-reset", {
		description: "Twiddle: reset config to defaults",
		handler: async (_args, ctx) => {
			await writeConfig({ threshold: 40, auto: false });
			const config = await getConfig();
			updateFooterStatus(ctx, config);
			twiddleNotify(ctx, config, "normal", "Twiddle config reset.");
		},
	});

	pi.registerCommand("twiddle-auto-on", {
		description: "Twiddle: enable auto-mode (footer: ≈ Twiddle)",
		handler: async (_args, ctx) => {
			const config = await getConfig();
			config.auto = true;
			await writeConfig(config);
			updateFooterStatus(ctx, config);
			twiddleNotify(ctx, config, "normal", "auto-mode ON — all prompts optimized.");
		},
	});

	pi.registerCommand("twiddle-auto-off", {
		description: "Twiddle: disable auto-mode (footer: ~ Twiddle)",
		handler: async (_args, ctx) => {
			const config = await getConfig();
			config.auto = false;
			await writeConfig(config);
			updateFooterStatus(ctx, config);
			twiddleNotify(ctx, config, "normal", "auto-mode OFF — use ~ prefix to optimize.");
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
			const shortNote =
				stats.shortResponseCount > 0
					? ` · ${stats.shortResponseCount} respostas curtas`
					: "";
			const fallbackNote =
				stats.fallbackUsed > 0
					? ` · ${stats.fallbackUsed} via fallback`
					: "";
			const summary = `Twiddle Report: ${stats.totalOptimizations} ops · ` +
				`${stats.totalInputTokens}→${stats.totalOutputTokens} tokens ` +
				`(avg ${avgRatio}%) · ` +
				`${stats.totalBudgetExceeded} exceeded budget · ` +
				`${stats.totalElapsed.toFixed(0)}s total` +
				shortNote + fallbackNote;
			ctx.ui.notify(summary, "info");

			// Show last optimization preview
			if (lastOptimization) {
				const lo = lastOptimization;
				const intentLabel = lo.intent ? ` | 🎯 ${lo.intent}` : "";
				const header = `Última: 📐 ${lo.scope}${intentLabel} | 🧾 ${lo.inputTokens}→${lo.outputTokens} tokens ⏳ ${lo.elapsed}s`;
				ctx.ui.notify(header, "info");
				ctx.ui.notify(lo.text, "info");
			}
		},
	});

	pi.registerCommand("twiddle-verbose", {
		description: "Twiddle: set verbosity level (quiet, normal, debug)",
		handler: async (args, ctx) => {
			const config = await getConfig();
			const current = config.verbose ?? "normal";

			if (!args) {
				ctx.ui.notify(`Current verbosity: ${current}. Use /twiddle-verbose <quiet|normal|debug>.`, "info");
				return;
			}

			const level = args.toLowerCase().trim();
			if (level !== "quiet" && level !== "normal" && level !== "debug") {
				ctx.ui.notify("Use: quiet, normal, or debug.", "error");
				return;
			}

			config.verbose = level as "quiet" | "normal" | "debug";
			await writeConfig(config);
			twiddleNotify(ctx, config, "normal", `Twiddle verbosity: ${level}.`);
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
				const pick = await ctx.ui.select("Select fallback model:", options);
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

	pi.registerCommand("twiddle-setup", {
		description: "Twiddle: interactive setup for all configuration",
		handler: async (_args, ctx) => {
			// Loop until user exits
			while (true) {
				const config = await getConfig();
				const fallbacks = config.fallbackModels ?? [];
				const fallbackList =
					fallbacks.length > 0
						? fallbacks.map((m) => `${m.provider}/${m.id}`).join(", ")
						: "none";

				const options = [
					`Model: ${config.model ? `${config.model.provider}/${config.model.id}` : "not set"}`,
					`Threshold: ${config.threshold ?? 40}%`,
					`Timeout: ${config.timeout ?? 15}s`,
					`Verbosity: ${config.verbose ?? "normal"}`,
					`Auto-mode: ${config.auto ? "ON" : "OFF"}`,
					`Quick model: ${config.quickModel ? `${config.quickModel.provider}/${config.quickModel.id}` : "none"}`,
					`Fallbacks: ${fallbackList}`,
					"Exit setup",
				];

				const choice = await ctx.ui.select("Twiddle Setup — select an option to change:", options);
				if (choice === undefined || choice === "Exit setup") return;

				const idx = options.indexOf(choice);

				switch (idx) {
					case 0: { // Model
						const all = ctx.modelRegistry.getAvailable();
						if (all.length === 0) {
							ctx.ui.notify("No models available. Configure an API key first.", "warning");
							break;
						}
						const modelOptions = all.map((m) => `${m.provider}/${m.id}  (${m.name})`);
						const pick = await ctx.ui.select("Select optimization model:", modelOptions);
						if (pick !== undefined) {
							const mi = modelOptions.indexOf(pick);
							const selected = all[mi];
							config.model = { provider: selected.provider, id: selected.id };
							await writeConfig(config);
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
					case 3: { // Verbosity
						const levels = ["quiet", "normal", "debug"];
						const current = config.verbose ?? "normal";
						const next = levels[(levels.indexOf(current) + 1) % levels.length];
						config.verbose = next as "quiet" | "normal" | "debug";
						await writeConfig(config);
						break;
					}
					case 4: { // Auto-mode
						config.auto = !config.auto;
						await writeConfig(config);
						break;
					}
					case 5: { // Quick model
						const allQuick = ctx.modelRegistry.getAvailable();
						if (allQuick.length === 0) {
							ctx.ui.notify("No models available.", "warning");
						} else {
							const opts = allQuick.map((m) => `${m.provider}/${m.id}  (${m.name})`);
							opts.push("Clear");
							opts.push("Cancel");
							const pick = await ctx.ui.select("Select quick model (trivial/low prompts):", opts);
							if (pick === "Clear") {
								config.quickModel = undefined;
								await writeConfig(config);
							} else if (pick !== undefined && pick !== "Cancel") {
								const mi = opts.indexOf(pick);
								const sel = allQuick[mi];
								config.quickModel = { provider: sel.provider, id: sel.id };
								await writeConfig(config);
							}
						}
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
									const pick = await ctx.ui.select("Select fallback model:", opts);
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
								const toRemove = await ctx.ui.select("Remove which fallback?", fbLabels);
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
		quickModel?: { provider: string; id: string };
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
		const projectContext = getCachedContext();
		const thinkingLevel = pi.getThinkingLevel();
		const scope = detectScope(req.effectiveText);
		const systemPrompt = buildSystemPrompt({
			intent,
			projectContext: projectContext ?? undefined,
			thinkingLevel,
			scope,
		});

		startTwiddleAnim(ctx, config);
		const fr = await optimizeWithFallback(
			req.effectiveText,
			req.model,
			req.fallbackModels,
			pi,
			req.threshold,
			systemPrompt,
			req.timeoutSeconds,
			scope,
			req.quickModel,
			ctx.signal ?? undefined,
		);
		stopTwiddleAnim(ctx, config);

		const elapsed = ((Date.now() - req.startTime) / 1000).toFixed(1);
		lastPromptWasOptimized = true;

		stats.totalOptimizations++;
		stats.totalInputTokens += fr.result.inputTokens;
		stats.totalOutputTokens += fr.result.outputTokens;
		stats.totalElapsed += parseFloat(elapsed);
		if (fr.result.exceedsBudget) stats.totalBudgetExceeded++;
		if (fr.isFallback) stats.fallbackUsed++;
		lastOptimization = {
			text: fr.result.optimizedText,
			intent,
			scope,
			inputTokens: fr.result.inputTokens,
			outputTokens: fr.result.outputTokens,
			elapsed,
		};

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
	// Flag para evitar dupla otimização: quando o input event já processou
	// um comando (/skill ~texto), before_agent_start deve pular.
	// Também usada em auto-mode para proteger comandos sem ~.
	let skipAgentOptimization = false;
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
			twiddleNotify(ctx, config, "normal",
				"Twiddle: no models available. Configure an API key first. Prompts will be sent unchanged this session.",
				"warning",
			);
			return false;
		}

		const options = models.map((model: Model) => pickModelLabel(model));
		options.push("Cancel");
		const choice = await ctx.ui.select("Twiddle needs an optimization model:", options);
		if (choice === undefined || choice === "Cancel") {
			missingModelSetupSilencedForSession = true;
			twiddleNotify(ctx, config, "normal",
				"Twiddle: no model selected. Prompts will be sent unchanged this session. Use /twiddle-model to enable optimization.",
				"warning",
			);
			return false;
		}

		const selected = models[options.indexOf(choice)];
		config.model = { provider: selected.provider, id: selected.id };
		await writeConfig(config);
		updateFooterStatus(ctx, config);
		twiddleNotify(ctx, config, "normal", `Twiddle model: ${pickModelLabel(selected)}`);
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
			// Comando sem ~: em auto-mode, protege de otimização dupla
			if (config.auto) {
				skipAgentOptimization = true;
			}
			return; // continue — passa intacto
		}

		// Comando com ~: extrai, otimiza, reconstroi
		const commandPrefix = text.slice(0, tildeIdx).trimEnd();
		const rawText = text.slice(tildeIdx + 2).trim();
		if (!rawText) return;

		const hasModel = await ensureModelConfigured(text, ctx, config);
		if (!hasModel || !config.model) {
			skipAgentOptimization = true;
			return;
		}

		skipAgentOptimization = true;
		const startTime = Date.now();

		try {
			const parsed = parseOverride(rawText);
			const effectiveText = parsed.text;

			if (parsed.skipOptimization) {
				return { action: "transform", text: `${commandPrefix} ${effectiveText}` };
			}

			const { fr, elapsed } = await runOptimizationCore({
				effectiveText,
				forcedIntent: parsed.intent,
				model: config.model,
				fallbackModels: config.fallbackModels,
				quickModel: config.quickModel,
				threshold: config.threshold ?? 40,
				timeoutSeconds: config.timeout ?? 15,
				startTime,
			}, ctx, config);

			const verbose = config.verbose ?? "normal";
			if (!parsed.quiet && verbose !== "quiet") {
				const totalModels = 1 + (config.fallbackModels?.length ?? 0);
				pi.sendMessage({
					customType: "twiddle",
					content: `Twiddle~ 🧠 ${fr.usedModel.provider}/${fr.usedModel.id} 🧩 ${fr.result.inputTokens}->${fr.result.outputTokens} ⏳ ${elapsed}s - try ${fr.attemptIndex}/${totalModels}`,
					display: true,
				});
			}

			if (fr.result.exceedsBudget) {
				twiddleNotify(ctx, config, "quiet",
					`Twiddle: optimization exceeded budget (${fr.result.inputTokens} → ${fr.result.outputTokens}). Sending original.`,
					"warning",
				);
				return;
			}

			return { action: "transform", text: `${commandPrefix} ${fr.result.optimizedText}` };
		} catch (err) {
			skipAgentOptimization = false;
			const message = err instanceof Error ? err.message : String(err);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			stopTwiddleAnim(ctx, config);
			pi.sendMessage({
				customType: "twiddle",
				content: `Twiddle~ ⚠️ ${buildModelChain(config.model, config.fallbackModels)} | all failed in ${elapsed}s | ${message}`,
				display: true,
			});
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
		quickModel?: { provider: string; id: string };
		startTime: number;
		threshold: number;
		mode: "auto" | "~";
		forcedIntent?: IntentCategory;
		quiet?: boolean;
		verbose?: string;
		timeoutSeconds?: number;
	} | null = null;

	pi.on("before_agent_start", async (event, ctx) => {
		// Se o input event já processou o prompt (comando com ~)
		// ou protegeu (auto-mode + comando sem ~), pula otimização.
		if (skipAgentOptimization) {
			skipAgentOptimization = false; // reset
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

		// Auto-mode: skip trivial prompts (<5 words, not a command)
		if (config.auto && !hasPrefix) {
			const scope = detectScope(rawPrompt);
			const wordCount = rawPrompt.split(/\s+/).length;
			if (scope === "trivial" && wordCount < 5) return;
		}

		// Parse override prefixes (~raw:, ~bug:, ~~, etc.)
		const parsed = parseOverride(rawPrompt);
		if (parsed.skipOptimization) {
			// ~raw: skip optimization entirely
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
			quickModel: config.quickModel,
			startTime: Date.now(),
			threshold: config.threshold ?? 40,
			mode,
			forcedIntent: parsed.intent,
			quiet: parsed.quiet,
			verbose: config.verbose ?? "normal",
			timeoutSeconds: config.timeout ?? 15,
		};
	});

	pi.on("context", async (event, ctx) => {
		if (!pendingOptimization) return;

		const {
			rawPrompt,
			effectiveText,
			model: modelRef,
			fallbackModels,
			quickModel,
			startTime,
			threshold,
			mode,
			forcedIntent,
			quiet,
			verbose,
			timeoutSeconds,
		} = pendingOptimization;
		pendingOptimization = null;

		const config = await getConfig();

		try {
			const { fr, elapsed } = await runOptimizationCore({
				effectiveText,
				forcedIntent,
				model: modelRef,
				fallbackModels,
				quickModel,
				threshold,
				timeoutSeconds: timeoutSeconds ?? 15,
				startTime,
			}, ctx, config);

			const messages = [...event.messages];
			let userMsgIdx = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "user") {
					userMsgIdx = i;
					break;
				}
			}

			if (!fr.result.exceedsBudget && userMsgIdx >= 0) {
				const msg = messages[userMsgIdx];
				if (typeof msg.content === "string") {
					messages[userMsgIdx] = { ...msg, content: fr.result.optimizedText };
				} else if (Array.isArray(msg.content)) {
					const newContent = msg.content.map((block) =>
						block.type === "text"
							? { ...block, text: fr.result.optimizedText }
							: block,
					);
					messages[userMsgIdx] = { ...msg, content: newContent };
				}
			}

			if (!quiet && verbose !== "quiet") {
				const totalModels = 1 + (fallbackModels?.length ?? 0);
				ctx.ui.notify(
					`Twiddle~ 🧠 ${fr.usedModel.provider}/${fr.usedModel.id} 🧩 ${fr.result.inputTokens}->${fr.result.outputTokens} ⏳ ${elapsed}s - try ${fr.attemptIndex}/${totalModels}`,
					"info",
				);
			}

			return { messages };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			stopTwiddleAnim(ctx, config);
			ctx.ui.notify(`⚠️ Twiddle: ${buildModelChain(modelRef, fallbackModels)} | all failed in ${elapsed}s | ${message}`, "warning");
			return { messages: event.messages };
		}
	});
}
