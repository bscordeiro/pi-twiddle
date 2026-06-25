import type { TwiddleConfig } from "./config";

const FOOTER_WORD = "Twiddle";
const ANSI_DIM = "\x1b[2m";
const ANSI_SOFT = "\x1b[37m";
const ANSI_BRIGHT = "\x1b[97m";
const ANSI_RESET = "\x1b[0m";

function formatFooterPrefix(config: Pick<TwiddleConfig, "auto">): string {
	return config.auto ? "≈" : "~";
}

export function formatFooterLabel(config: Pick<TwiddleConfig, "auto">): string {
	return `${formatFooterPrefix(config)} ${FOOTER_WORD}`;
}

export function formatFooterShimmerFrame(
	config: Pick<TwiddleConfig, "auto">,
	frame: number,
): string {
	const highlightIndex = (frame % (FOOTER_WORD.length + 3)) - 1;
	const letters = [...FOOTER_WORD]
		.map((letter, index) => {
			const distance = Math.abs(index - highlightIndex);
			if (distance === 0) return `${ANSI_BRIGHT}${letter}${ANSI_RESET}`;
			if (distance === 1) return `${ANSI_SOFT}${letter}${ANSI_RESET}`;
			return `${ANSI_DIM}${letter}${ANSI_RESET}`;
		})
		.join("");

	return `${ANSI_DIM}${formatFooterPrefix(config)} ${ANSI_RESET}${letters}`;
}
