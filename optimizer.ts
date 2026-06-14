/**
 * Prompt optimization engine.
 * Uses pi subprocess (pi -q -p) to call the optimization model.
 * This avoids API key/auth issues by reusing pi's own auth resolution.
 *
 * System prompt is now composed dynamically from base + intent adendos
 * + project context + scope directives + thinking-level hints.
 */
import { countTokens } from "./tokenizer";
import { extractProtectedFragments, restoreFragments } from "./preserve";
import type { IntentCategory } from "./intent";
import type { ProjectContext } from "./project";

export type Scope = "trivial" | "low" | "medium" | "high" | "epic";

export function detectScope(text: string): Scope {
	const wordCount = text.split(/\s+/).length;
	const lineCount = text.split("\n").length;
	const hasCodeBlock = /```[\s\S]*?```/.test(text);

	if (lineCount > 15 && hasCodeBlock) return "epic";
	if (lineCount > 10 || wordCount > 150) return "high";
	if (wordCount > 80) return "medium";
	if (wordCount > 20) return "low";
	return "trivial";
}

// ──────────────────────────────────────────────
//  Base System Prompt (language, rules, format)
// ──────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are a Prompt Translator and Token Optimizer for AI coding agents. Not a planner, architect, or requirements analyst — improve expression only; never change scope or add requirements.

Rewrite user prompts into concise, natural, high-signal English. Maximize clarity and precision; minimize tokens, ambiguity, and redundancy.

**Language**: Always output English — regardless of input language. No exceptions. No meta-commentary.

**Rules**:
1. Translate semantically — meaning over words. Use standard engineering terminology.
2. Be concise. Eliminate every redundant word, filler, and repetition. Every word must earn its place.
3. Resolve obvious ambiguity through rewording only — never add tech stack, architecture patterns, libraries, or scope.
4. Silently fix spelling, grammar, and punctuation.
5. Never invent APIs, parameters, or assume undocumented behavior.
6. Never modify: {{PRESERVE_N}}, variable names, identifiers, class/function/library/framework names, URLs, file paths, service names.
7. Complex prompts: use Markdown only when it improves clarity. Simple questions: keep flat.
8. Output ONLY the rewritten prompt. No explanations, notes, or code fences unless the input explicitly requests them.

**Scope-aware formatting**:

| Size | Characters | Approach |
|------|------------|----------|
| Low | <80 | Flat text |
| Medium | 80~300 | Remove redundancy, improve readability |
| High | 300~800 | Consolidate; compact Markdown if beneficial |
| Epic | >800 | Aggressively deduplicate; output must be shorter than input |

**Examples**:
- "adicione autenticação jwt" → "Implement JWT-based authentication."
- "melhore a performance" → "Optimize performance."
- "Fix the login bug." → "Investigate and fix the login issue."
- "Create a login API." → ❌ "Create a login API with JWT and RBAC."

The coding agent understands English best. Make every word count.`;

// ──────────────────────────────────────────────
//  Aggressive Compression Adendo
//  Applied when compressionLevel is auto/max.
//  Strips articles, fillers, pleasantries for
//  maximum token density.
// ──────────────────────────────────────────────

const AGGRESSIVE_COMPRESSION = `
## Maximum Compression Mode
You are in maximum compression mode. Apply these additional rules:

### Strip non-essential words
- **Articles**: Remove "a", "an", "the" where meaning is clear without them.
- **Fillers**: Remove "just", "really", "basically", "actually", "simply", "literally".
- **Politeness**: Never include "please", "could you", "I'd like", "would be great", "can you help me".

### Prefer fragments
- Noun phrases and verb phrases over full sentences.
- Example: "Add JWT auth" not "Could you please add JWT authentication".

### Short synonyms
- "fix" over "investigate and resolve"
- "use" over "utilize", "make use of"
- "add" over "go ahead and add", "implement support for"
- "check" over "take a look at", "verify whether"

### No hedging
- Remove "might want to", "maybe", "possibly", "perhaps", "it could be", "I think".
- State actions directly.

### Technical precision > grammar
- Fragments are acceptable if technical meaning is unambiguous.
- Never sacrifice technical accuracy for grammatical completeness.`;

// ──────────────────────────────────────────────
//  Intent Adendos — appended to base prompt
//  based on detected intent category.
// ──────────────────────────────────────────────

const INTENT_ADENDOS: Record<IntentCategory, string> = {
	bug_fix: `
## Bug Fix Mode
- Preserve error messages, stack traces, and reproduction steps verbatim.
- Emphasize the symptoms and expected vs actual behavior.
- Include context about when the bug was introduced if mentioned.
- Do NOT add feature suggestions — focus on diagnosis and fix.`,

	new_feature: `
## New Feature Mode
- Structure the request with clear acceptance criteria.
- Include scope boundaries (what to build, what NOT to build).
- Reference existing patterns, conventions, or similar components if mentioned.
- Keep implementation details; remove speculative design.`,

	refactor: `
## Refactor Mode
- Preserve behavioral descriptions — the output must do the same thing.
- Emphasize the target structure or pattern being adopted.
- Include any constraints (no breaking changes, maintain API compat).
- Do NOT add new features to the scope.`,

	research: `
## Research Mode
- Preserve the open-ended nature of the question.
- Do not over-structure or imply a solution direction.
- Keep all sub-questions; they are intentional.
- Only compress filler words — preserve the investigative intent.`,

	testing: `
## Testing Mode
- Structure to include test types (unit, integration, e2e).
- Emphasize coverage targets and edge cases.
- Include mocking/stubbing requirements if mentioned.
- Preserve framework-specific testing terminology.`,

	review: `
## Review Mode
- Structure for code review context (what changed, what to check).
- Include review focus areas (security, performance, correctness).
- Preserve file paths and diff references.`,

	docs: `
## Documentation Mode
- Structure for documentation updates (what to document, target audience).
- Include format requirements (README, API docs, ADR).
- Preserve technical accuracy over conciseness.`,

	infrastructure: `
## Infrastructure Mode
- Preserve environment details (OS, cloud provider, tool versions).
- Structure CI/CD, deployment, or configuration steps.
- Include rollback/verification concerns if mentioned.`,

	design: `
## Design Mode
- Structure for architectural reasoning (trade-offs, constraints, alternatives).
- Preserve technical depth — this is NOT a code generation task.
- Include non-functional requirements (scalability, latency, security).`,
};

// ──────────────────────────────────────────────
//  Backward-compatible export
// ──────────────────────────────────────────────

/** @deprecated Use buildSystemPrompt() for dynamic composition. */
export const OPTIMIZATION_SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

// ──────────────────────────────────────────────
//  Dynamic System Prompt Builder
// ──────────────────────────────────────────────

const promptCache = new Map<string, string>();
const MAX_PROMPT_CACHE = 5;

type CompressionLevel = "off" | "auto" | "max";

const SCOPE_DIRECTIVES: Record<Scope, string> = {
	trivial:
		"This is a TRIVIAL scope prompt (<80 chars). Maximum compression — output must be shorter than input.",
	low: "This is a LOW scope prompt (80-300 chars). Be concise — flat text preferred.",
	medium:
		"This is a MEDIUM scope prompt (300-800 chars). Remove redundancy; compact Markdown if beneficial.",
	high: "This is a HIGH scope prompt. Structure carefully; preserve all technical details.",
	epic:
		"This is an EPIC scope prompt (>800 chars). Preserve nuance; structure for multi-step execution. Do not over-compress.",
};

function buildIntentSection(intent?: IntentCategory): string | undefined {
	if (!intent) return undefined;
	return INTENT_ADENDOS[intent];
}

function buildProjectContextSection(projectContext?: ProjectContext): string | undefined {
	if (!projectContext) return undefined;

	const lines: string[] = ["## Project Context"];
	if (projectContext.language) lines.push(`- Primary language: ${projectContext.language}`);
	if (projectContext.runtime) lines.push(`- Runtime: ${projectContext.runtime}`);
	if (projectContext.framework) lines.push(`- Framework: ${projectContext.framework}`);
	if (projectContext.packageManager) lines.push(`- Package manager: ${projectContext.packageManager}`);
	if (projectContext.type === "monorepo") lines.push("- This is a monorepo.");
	lines.push(
		"Use project-specific conventions and patterns when optimizing. " +
		"Preserve framework-specific terminology.",
	);
	return lines.join("\n");
}

function buildThinkingLevelSection(thinkingLevel?: string): string | undefined {
	if (thinkingLevel === "high") {
		return (
			"The main model is in high-thinking mode. " +
			"Markdown structure is especially valuable for complex prompts."
		);
	}

	if (thinkingLevel === "low" || thinkingLevel === "off") {
		return (
			"The main model is in low-thinking mode. " +
			"Keep the prompt extremely concise and direct. No markdown."
		);
	}

	return undefined;
}

function buildScopeSection(scope?: PromptScope): string | undefined {
	if (!scope) return undefined;
	return SCOPE_DIRECTIVES[scope];
}

function shouldApplyAggressiveCompression(
	compressionLevel?: CompressionLevel,
	scope?: Scope,
): boolean {
	if (!compressionLevel || compressionLevel === "off" || !scope) return false;
	return compressionLevel === "max" || (compressionLevel === "auto" && ["trivial", "low"].includes(scope));
}

export interface SystemPromptOptions {
	intent?: IntentCategory;
	projectContext?: ProjectContext;
	thinkingLevel?: string;
	scope?: Scope;
	inputTokens?: number;
	/** Compression aggressiveness: off, auto (trivial/low only), max (always) */
	compressionLevel?: CompressionLevel;
}

/**
 * Build a dynamic system prompt by composing base + intent adendo
 * + project context + scope directive + thinking-level hint.
 */
export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
	// Cache: same options → same prompt (LRU with 5 entries)
	const key = JSON.stringify(options);
	const cached = promptCache.get(key);
	if (cached) return cached;

	const parts = [BASE_SYSTEM_PROMPT];

	const sections = [
		buildIntentSection(options.intent),
		buildProjectContextSection(options.projectContext),
		buildThinkingLevelSection(options.thinkingLevel),
		buildScopeSection(options.scope),
	];

	for (const section of sections) {
		if (section) parts.push(section);
	}

	if (shouldApplyAggressiveCompression(options.compressionLevel, options.scope)) {
		parts.push(AGGRESSIVE_COMPRESSION);
	}

	const result = parts.join("\n\n");
	if (promptCache.size >= MAX_PROMPT_CACHE) {
		const first = promptCache.keys().next().value;
		if (first !== undefined) promptCache.delete(first);
	}
	promptCache.set(key, result);
	return result;
}

export interface OptimizationResult {
	optimizedText: string;
	inputTokens: number;
	outputTokens: number;
	/** true if output exceeded input + threshold margin */
	exceedsBudget: boolean;
	/** Count of protected fragments by type */
	fragmentStats: { codeBlocks: number; inlineCode: number; urls: number; hashes: number; versions: number };
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

type ExecFn = (args: string[]) => Promise<ExecResult>;

/**
 * Optimize a prompt by running pi as a subprocess with the optimization system prompt.
 *
 * @param rawText - The user's raw prompt (without the ~ prefix)
 * @param modelRef - Provider and model ID to use for optimization
 * @param execFn - Function to execute pi (e.g., pi.exec, or any compatible wrapper)
 * @param thresholdPercent - Token budget threshold (default: 20%)
 * @param systemPrompt - Custom system prompt (default: BASE_SYSTEM_PROMPT)
 * @param signal - Optional AbortSignal
 */
export async function optimizePrompt(
	rawText: string,
	modelRef: { provider: string; id: string },
	execFn: ExecFn,
	thresholdPercent: number = 20,
	systemPrompt?: string,
	signal?: AbortSignal,
): Promise<OptimizationResult> {
	const inputTokens = countTokens(rawText);

	// Token Budget Guard: check input BEFORE calling the model.
	// If the raw prompt exceeds 70% of a typical context window (~128K),
	// skip optimization — the model will likely fail or produce garbage.
	// Return gracefully so callers handle it as a budget exceed (not an error).
	const MAX_INPUT_TOKENS = 90000; // ~70% of 128K
	if (inputTokens > MAX_INPUT_TOKENS) {
		return {
			optimizedText: rawText,
			inputTokens,
			outputTokens: inputTokens,
			exceedsBudget: true,
			fragmentStats: { codeBlocks: 0, inlineCode: 0, urls: 0, hashes: 0, versions: 0 },
		};
	}

	// Step 1: Extract protected fragments (code, logs, URLs, hashes)
	const { sanitized, fragments, stats: fragmentStats } = extractProtectedFragments(rawText);

	// Step 2: Wrap input in <transform> tags so the model treats it as data,
	// not as a conversational user message.
	const taggedInput = `<transform>${sanitized}</transform>`;

	// Step 3: Build pi subprocess command with minimal overhead flags.
	const finalPrompt = systemPrompt ?? BASE_SYSTEM_PROMPT;
	const piArgs = [
		"-p",
		"--no-tools",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--model",
		`${modelRef.provider}/${modelRef.id}`,
		"--thinking",
		"off",
		"--system-prompt",
		finalPrompt,
		taggedInput,
	];

	const result = await execFn(piArgs);

	// Step 4: Validate subprocess
	if (result.code !== 0 || result.killed) {
		// Detect timeout/kill (SIGTERM = exit 143, or killed flag)
		if (result.killed || result.code === 143 || result.code === null) {
			throw new Error(
				`Optimization model timed out. The response was taking too long.`,
			);
		}

		// Strip ANSI/escape sequences from stderr to prevent rendering issues in the TUI
		const rawStderr = result.stderr?.trim() || "unknown error";
		const errMsg = rawStderr.replace(
			/\x1b(?:\[[0-9;<=>?]*[A-Za-z@-~]|\][^\x07]*\x07|_[^\x07]*\x07|\\.)/g,
			"",
		);
		throw new Error(`pi subprocess failed (exit ${result.code}): ${errMsg}`);
	}

	const optimizedRaw = result.stdout?.trim() ?? "";
	if (!optimizedRaw) {
		throw new Error("Optimization returned empty content");
	}

	// Step 5: Restore protected fragments
	const optimizedText = restoreFragments(optimizedRaw, fragments);

	// Step 6: Check token budget (configurable threshold)
	const outputTokens = countTokens(optimizedText);
	const exceedsBudget =
		outputTokens > Math.ceil(inputTokens * (1 + thresholdPercent / 100));

	return { optimizedText, inputTokens, outputTokens, exceedsBudget, fragmentStats };
}
