export interface MissingModelSetupDecision {
	missingModel: boolean;
	shouldPrompt: boolean;
}

export function isTwiddleCommand(text: string): boolean {
	return /^\/twiddle(?:\b|-)/.test(text.trim());
}

export function decideMissingModelSetup(
	text: string,
	options: {
		hasModel: boolean;
		sessionSilenced: boolean;
	},
): MissingModelSetupDecision {
	if (options.hasModel) {
		return { missingModel: false, shouldPrompt: false };
	}

	if (!text.trim() || isTwiddleCommand(text) || options.sessionSilenced) {
		return { missingModel: true, shouldPrompt: false };
	}

	return { missingModel: true, shouldPrompt: true };
}
