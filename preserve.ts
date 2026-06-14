/**
 * Regex-based extraction of non-translatable content.
 * Extracts code blocks, inline code, URLs, file paths, hex hashes,
 * and other technical tokens before sending to the optimization model.
 * Reinserts them after optimization via numbered placeholders.
 */

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const URL_RE = /https?:\/\/[^\s)]+/g;
const HEX_HASH_RE = /\b(?=[0-9a-fA-F]*[a-fA-F])(?=[0-9a-fA-F]*[0-9])[0-9a-fA-F]{7,40}\b/g;
const SEMVER_RE = /\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b/g;
const PLACEHOLDER_RE = /\{\{PRESERVE_(\d+)\}\}/g;

const PROTECTION_PATTERNS: Array<{ regex: RegExp; statKey: "codeBlocks" | "inlineCode" | "urls" | "hashes" | "versions" }> = [
	{ regex: CODE_BLOCK_RE, statKey: "codeBlocks" },
	{ regex: INLINE_CODE_RE, statKey: "inlineCode" },
	{ regex: URL_RE, statKey: "urls" },
	{ regex: HEX_HASH_RE, statKey: "hashes" },
	{ regex: SEMVER_RE, statKey: "versions" },
];

/**
 * Extract protected fragments and replace with numbered placeholders.
 * Returns the sanitized text, a lookup map, and per-type stats.
 */
export function extractProtectedFragments(text: string): {
	sanitized: string;
	fragments: Map<number, string>;
	stats: { codeBlocks: number; inlineCode: number; urls: number; hashes: number; versions: number };
} {
	const fragments = new Map<number, string>();
	const stats = { codeBlocks: 0, inlineCode: 0, urls: 0, hashes: 0, versions: 0 };
	let counter = 0;

	for (const { regex, statKey } of PROTECTION_PATTERNS) {
		// Reset lastIndex for global regex reuse
		regex.lastIndex = 0;
		text = text.replace(regex, (match) => {
			counter++;
			fragments.set(counter, match);
			stats[statKey]++;
			return `{{PRESERVE_${counter}}}`;
		});
	}

	return { sanitized: text, fragments, stats };
}

/**
 * Restore protected fragments from placeholders.
 */
export function restoreFragments(
	text: string,
	fragments: Map<number, string>,
): string {
	return text.replace(PLACEHOLDER_RE, (_match, numStr) => {
		const num = Number.parseInt(numStr, 10);
		return fragments.get(num) ?? `{{PRESERVE_${numStr}}}`;
	});
}
