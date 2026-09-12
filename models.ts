/**
 * Model list filtering for Twiddle selectors.
 * Plain substring match over provider, id, and display name so users can
 * narrow long catalogs by typing part of what they remember.
 */

export interface FilterableModel {
	provider: string;
	id: string;
	name: string;
}

export function filterModels<T extends FilterableModel>(models: T[], query: string): T[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return models;
	return models.filter((m) => {
		const haystack = `${m.provider} ${m.id} ${m.name}`.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
}
