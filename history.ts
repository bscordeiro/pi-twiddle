export interface UserMessageLike {
	role: string;
	content?: unknown;
}

export interface AppliedTransformation {
	original: string;
	applied: string;
}

export interface StoredComparison {
	original: string;
	applied: string;
	model: string;
	scope: string;
	intent: string;
	inputTokens: number | "?";
	outputTokens: number | "?";
	elapsed: string;
	attempt: string;
}

export interface SessionEntrySource {
	getBranch?: () => readonly unknown[];
	getEntries?: () => readonly unknown[];
}

function loadSessionEntries(sessionManager: SessionEntrySource | undefined): readonly unknown[] {
	try {
		return sessionManager?.getBranch?.() ?? sessionManager?.getEntries?.() ?? [];
	} catch {
		return sessionManager?.getEntries?.() ?? [];
	}
}

export function loadLatestComparison(
	sessionManager: SessionEntrySource | undefined,
): StoredComparison | null {
	const entries = loadSessionEntries(sessionManager);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "twiddle-comparison") {
			continue;
		}
		const data = entry.data;
		if (!isRecord(data) || typeof data.original !== "string" || typeof data.applied !== "string") {
			continue;
		}
		const attemptIndex = data.attemptIndex;
		const totalModels = data.totalModels;
		return {
			original: data.original,
			applied: data.applied,
			model: typeof data.model === "string" ? data.model : "unknown model",
			scope: typeof data.scope === "string" ? data.scope : "?",
			intent: typeof data.intent === "string" ? data.intent : "none",
			inputTokens: typeof data.inputTokens === "number" ? data.inputTokens : "?",
			outputTokens: typeof data.outputTokens === "number" ? data.outputTokens : "?",
			elapsed: typeof data.elapsed === "string" || typeof data.elapsed === "number"
				? String(data.elapsed)
				: "?",
			attempt: typeof attemptIndex === "number" && typeof totalModels === "number"
				? `${attemptIndex}/${totalModels}`
				: "?",
		};
	}
	return null;
}

export function loadAppliedTransformations(
	sessionManager: SessionEntrySource | undefined,
): AppliedTransformation[] {
	const entries = loadSessionEntries(sessionManager);
	return entries.flatMap((entry) => {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "twiddle-comparison") {
			return [];
		}
		const data = entry.data;
		if (!isRecord(data) || typeof data.original !== "string" || typeof data.applied !== "string") {
			return [];
		}
		return [{ original: data.original, applied: data.applied }];
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function messageSignature(message: UserMessageLike): string | null {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		const first = (message.content as Array<{ type?: string; text?: string }>).find(
			(block) => block?.type === "text",
		);
		return first?.text ?? null;
	}
	return null;
}

export function applyTextToUserMessage(message: UserMessageLike, text: string): UserMessageLike {
	if (typeof message.content === "string") return { ...message, content: text };
	if (Array.isArray(message.content)) {
		const content = message.content as Array<{ type?: string; text?: string }>;
		const textIndex = content.findIndex((block) => block?.type === "text");
		if (textIndex === -1) return message;
		return {
			...message,
			content: content.map((block, index) => index === textIndex ? { ...block, text } : block),
		};
	}
	return message;
}

export function applyKnownTransformations(
	messages: UserMessageLike[],
	transformations: readonly AppliedTransformation[],
	excludeLastUserMessage: boolean,
): void {
	const userIndices = messages
		.map((message, index) => message.role === "user" ? index : -1)
		.filter((index) => index >= 0);
	const lastIndex = excludeLastUserMessage ? userIndices.length - 1 : userIndices.length;
	const used = new Set<number>();
	for (let position = lastIndex - 1; position >= 0; position--) {
		const messageIndex = userIndices[position];
		const signature = messageSignature(messages[messageIndex]);
		if (signature === null) continue;
		for (let recordIndex = transformations.length - 1; recordIndex >= 0; recordIndex--) {
			if (used.has(recordIndex)) continue;
			const record = transformations[recordIndex];
			if (record.original !== signature) continue;
			messages[messageIndex] = applyTextToUserMessage(messages[messageIndex], record.applied);
			used.add(recordIndex);
			break;
		}
	}
}
