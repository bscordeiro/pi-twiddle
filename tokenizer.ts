/**
 * Simple heuristic token counter.
 * Approximates token count as characters / 4 for English-like text.
 * Good enough for the ±20% budget check.
 */
export function countTokens(text: string): number {
	if (!text) return 0;
	// Rough heuristic: 4 characters ≈ 1 token for English text
	// This handles both English and code reasonably well
	return Math.ceil(text.length / 4);
}
