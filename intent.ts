/**
 * Intent detection via keyword heuristics (pt-BR + EN).
 * Zero latency — regex only, no LLM calls.
 *
 * 9 categories mapped from Prompt-Optimizer Phase 1.
 * Fallback to undefined (General) when ambiguous.
 */

export type IntentCategory =
	| "bug_fix"
	| "new_feature"
	| "refactor"
	| "research"
	| "testing"
	| "review"
	| "docs"
	| "infrastructure"
	| "design";

interface IntentRule {
	category: IntentCategory;
	keywords: RegExp[];
}

const RULES: IntentRule[] = [
	{
		category: "bug_fix",
		keywords: [
			/\b(fix|bug|broken|not working|error|crash|exception|stack trace|traceback)\b/i,
			/\b(corrigir|consertar|arrumar|quebrado|quebrou|defeito|falha|resolve|resolver)\b/i,
		],
	},
	{
		category: "new_feature",
		keywords: [
			/\b(create|add|build|implement|develop|new feature)\b/i,
			/\b(criar|crie|adicionar|adicione|construir|construa|implementar|implemente|novo|nova funcionalidade)\b/i,
		],
	},
	{
		category: "refactor",
		keywords: [
			/\b(refactor|clean\s*up|restructure|rewrite|reorganize|simplify|improve code|code quality)\b/i,
			/\b(refatorar|refatore|limpar|reorganizar|reestruturar|simplificar|código limpo)\b/i,
		],
	},
	{
		category: "research",
		keywords: [
			/\b(how to|what is|why does|explain|explore|investigate|research|understand|how does|tell me|show me|find out|look into|which|where|when|who|how much|how many)\b/i,
			/\b(como|como fazer|o que é|por que|explique|explique-me|pesquise|investigue|entenda|descubra|me diga|me mostre|qual|quais|quanto|custa|onde|quem|quando|significa|diferença entre|vs\.?|versus|cotação|cotacao|preço|preco|valor do|vale a pena)\b/i,
			/\?$/m,
		],
	},
	{
		category: "testing",
		keywords: [
			/\b(test|tests|testing|coverage|spec|specs|unit test|integration test|e2e|TDD|write tests|add tests|test suite)\b/i,
			/\b(teste unitário|teste de integração|teste e2e|testar|escreva testes|adicione testes|crie testes|cobertura de teste|suíte de teste|TDD)\b/i,
		],
	},
	{
		category: "review",
		keywords: [
			/\b(review|audit|check|inspect|PR|pull request|code review)\b/i,
			/\b(revisar|revisão|revisar código|auditar|auditoria|inspecionar|PR|pull request)\b/i,
		],
	},
	{
		category: "docs",
		keywords: [
			/\b(document|docs|documentation|README|CHANGELOG|ADR|write docs|update docs)\b/i,
			/\b(documentar|documentação|documente|escrever docs|atualizar docs|README|CHANGELOG)\b/i,
		],
	},
	{
		category: "infrastructure",
		keywords: [
			/\b(deploy|CI|CD|docker|kubernetes|k8s|terraform|infra|infrastructure|pipeline|container|database|migration|backup|server|nginx|proxy)\b/i,
			/\b(deploy|implantar|CI|CD|docker|kubernetes|infra|infraestrutura|pipeline|container|banco de dados|migração|backup|servidor)\b/i,
		],
	},
	{
		category: "design",
		keywords: [
			/\b(design|architecture|architect|plan|blueprint|data model|schema|system design|component tree)\b/i,
			/\b(projetar|design|arquitetura|arquitetar|planejar|plano|modelo de dados|esquema|design de sistema)\b/i,
		],
	},
];

/**
 * Detect the intent category of a prompt via keyword scoring.
 *
 * Returns undefined if:
 * - No keywords match → General (no adendo)
 * - Multiple categories tie for highest score → ambiguous → General
 */
export function detectIntent(text: string): IntentCategory | undefined {
	const normalized = text.toLowerCase();
	const scores = new Map<IntentCategory, number>();

	for (const rule of RULES) {
		let score = 0;
		for (const re of rule.keywords) {
			const matches = normalized.match(re);
			if (matches) {
				score += matches.length;
			}
		}
		if (score > 0) {
			scores.set(rule.category, score);
		}
	}

	if (scores.size === 0) return undefined;

	// Find the category with the highest score
	let best: IntentCategory | undefined;
	let bestScore = 0;
	let ties = 0;

	for (const [cat, score] of scores) {
		if (score > bestScore) {
			best = cat;
			bestScore = score;
			ties = 1;
		} else if (score === bestScore) {
			ties++;
		}
	}

	// Ambiguous — multiple categories with same score
	if (ties > 1) return undefined;

	return best;
}
