/**
 * Prompt optimization engine.
 * Uses pi subprocess (pi -q -p) to call the optimization model.
 * This avoids API key/auth issues by reusing pi's own auth resolution.
 *
 * System prompt is now composed dynamically from base + intent adendos
 * + project context + scope directives + thinking-level hints.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const BASE_SYSTEM_PROMPT = `You are a prompt translator and compression filter for AI coding agents. Your only job is to rewrite the user's request so the next agent understands it faster. Do not solve, plan, expand, or analyze the task.

Output concise, natural, high-signal English. Preserve meaning exactly; reduce ambiguity and token waste.

**Priority order**:
1. Preserve the user's intent, constraints, scope, and requested output.
2. Preserve technical details exactly: {{PRESERVE_N}}, identifiers, APIs, commands, versions, paths, URLs, error text, logs, filenames, libraries, frameworks, and service names.
3. Improve wording: translate semantically, fix spelling/grammar, use standard engineering terminology.
4. Compress only when it does not remove useful detail.

**Hard rules**:
- Always output English, regardless of input language.
- Output ONLY the rewritten prompt. No preface, explanation, commentary, or code fence unless the user explicitly asks for one.
- Never add requirements, features, tech stack, libraries, architecture, acceptance criteria, or investigation steps not present in the input.
- Never invent APIs, parameters, endpoints, files, errors, versions, or undocumented behavior.
- Keep simple questions as one flat sentence. Use compact Markdown only for multi-part or complex requests.
- If input is already clear and short, make the smallest safe improvement; do not force shortening at the cost of meaning.

**Scope handling**:
- TRIVIAL/LOW: keep one sentence unless the input has multiple explicit parts.
- MEDIUM: remove filler and group related constraints if helpful.
- HIGH/EPIC: deduplicate repeated phrasing, keep distinct constraints, and structure only enough for unambiguous handoff. Do not create a plan.

**Examples**:
- "adicione autenticação jwt" → "Implement JWT authentication."
- "melhore a performance" → "Optimize performance."
- "Fix the login bug." → "Fix the login bug."
- "Create a login API." → "Create a login API."
- "Create a login API." → ❌ "Create a login API with JWT and RBAC."

The coding agent performs best with precise, scoped English. Make every word earn its place.`;

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
- Reuse acceptance criteria and scope boundaries already present in the input; never invent new ones.
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
- Only remove filler words — preserve the investigative intent.`,

	testing: `
## Testing Mode
- Reuse test types, coverage targets, and edge cases already present in the input; never invent new ones.
- Include mocking/stubbing requirements if mentioned.
- Preserve framework-specific testing terminology.`,

	review: `
## Review Mode
- Structure for code review context (what changed, what to check).
- Reuse review focus areas only when mentioned in the input; never invent new ones.
- Preserve file paths and diff references.`,

	docs: `
## Documentation Mode
- Structure for documentation updates (what to document, target audience).
- Reuse format requirements only when mentioned in the input (README, API docs, ADR).
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
- Reuse non-functional requirements only when mentioned in the input (scalability, latency, security).`,
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

const SCOPE_DIRECTIVES: Record<Scope, string> = {
	trivial:
		"This is a TRIVIAL prompt. Keep it as one short sentence; do not add structure.",
	low: "This is a LOW scope prompt. Prefer flat text and keep all explicit constraints.",
	medium:
		"This is a MEDIUM scope prompt. Remove filler; use compact Markdown only if it improves clarity.",
	high: "This is a HIGH scope prompt. Structure carefully; preserve all technical details and constraints.",
	epic:
		"This is an EPIC scope prompt. Deduplicate repeated phrasing, preserve distinct constraints, and structure for unambiguous handoff. Do not create a plan.",
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

function buildScopeSection(scope?: Scope): string | undefined {
	if (!scope) return undefined;
	return SCOPE_DIRECTIVES[scope];
}

export interface SystemPromptOptions {
	intent?: IntentCategory;
	projectContext?: ProjectContext;
	thinkingLevel?: string;
	scope?: Scope;
	inputTokens?: number;
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

const MAX_INLINE_PROMPT_BYTES = 64 * 1024;

async function executeWithPromptTransport(
	taggedInput: string,
	buildArgs: (promptArg: string) => string[],
	execFn: ExecFn,
): Promise<ExecResult> {
	if (Buffer.byteLength(taggedInput, "utf8") <= MAX_INLINE_PROMPT_BYTES) {
		return execFn(buildArgs(taggedInput));
	}

	const directory = await mkdtemp(join(tmpdir(), "pi-twiddle-"));
	const promptPath = join(directory, "prompt.txt");
	try {
		await writeFile(promptPath, taggedInput, { encoding: "utf8", mode: 0o600 });
		return await execFn(buildArgs(`@${promptPath}`));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/**
 * Optimize a prompt by running pi as a subprocess with the optimization system prompt.
 *
 * @param rawText - The user's raw prompt (without the ~ prefix)
 * @param modelRef - Provider and model ID to use for optimization
 * @param execFn - Function to execute pi (e.g., pi.exec, or any compatible wrapper)
 * @param thresholdPercent - Max expansion over input length in percent (default: 40%)
 * @param systemPrompt - Custom system prompt (default: BASE_SYSTEM_PROMPT)
 * @param signal - Optional AbortSignal
 */
export async function optimizePrompt(
	rawText: string,
	modelRef: { provider: string; id: string },
	execFn: ExecFn,
	thresholdPercent: number = 40,
	systemPrompt?: string,
	signal?: AbortSignal,
): Promise<OptimizationResult> {
	const inputTokens = countTokens(rawText);

	// Input size guard: check input BEFORE calling the model.
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
	const buildArgs = (promptArg: string) => [
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
		promptArg,
	];

	const result = await executeWithPromptTransport(taggedInput, buildArgs, execFn);

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

	// Step 4b: Verify protected-fragment integrity before restoring.
	// The model must return every {{PRESERVE_N}} placeholder exactly once:
	// a dropped, duplicated, or invented placeholder means code, URLs, or
	// versions would be lost or corrupted, so refuse the output and let
	// callers fall back to the original prompt (possibly via next model).
	const expectedPlaceholders = [...sanitized.matchAll(/\{\{PRESERVE_(\d+)\}\}/g)].map((m) => m[1]);
	const actualPlaceholders = [...optimizedRaw.matchAll(/\{\{PRESERVE_(\d+)\}\}/g)].map((m) => m[1]);
	const countPlaceholders = (ids: string[]): Map<string, number> => {
		const counts = new Map<string, number>();
		for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
		return counts;
	};
	const expectedCounts = countPlaceholders(expectedPlaceholders);
	const actualCounts = countPlaceholders(actualPlaceholders);
	const placeholdersIntact =
		expectedCounts.size === actualCounts.size &&
		[...expectedCounts.entries()].every(([id, count]) => actualCounts.get(id) === count);
	if (!placeholdersIntact) {
		throw new Error(
			"Optimization dropped or altered protected fragments (code, URLs, versions). Sending original.",
		);
	}

	// Step 5: Restore protected fragments
	const optimizedText = restoreFragments(optimizedRaw, fragments);

	// Step 6: Check expansion limit (configurable threshold)
	const outputTokens = countTokens(optimizedText);
	const exceedsBudget =
		outputTokens > Math.ceil(inputTokens * (1 + thresholdPercent / 100));

	return { optimizedText, inputTokens, outputTokens, exceedsBudget, fragmentStats };
}
