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

interface ThemeLike {
	fg: (color: string, text: string) => string;
}

export function formatFooterShimmerFrame(
	config: Pick<TwiddleConfig, "auto">,
	frame: number,
	theme?: ThemeLike,
): string {
	const highlightIndex = (frame % (FOOTER_WORD.length + 3)) - 1;
	const paint = (color: string, text: string): string =>
		theme ? theme.fg(color, text) : `${ANSI_DIM}${text}${ANSI_RESET}`;
	const highlight = (text: string): string =>
		theme ? theme.fg("accent", text) : `${ANSI_BRIGHT}${text}${ANSI_RESET}`;
	const neighbor = (text: string): string =>
		theme ? theme.fg("muted", text) : `${ANSI_SOFT}${text}${ANSI_RESET}`;
	const letters = [...FOOTER_WORD]
		.map((letter, index) => {
			const distance = Math.abs(index - highlightIndex);
			if (distance === 0) return highlight(letter);
			if (distance === 1) return neighbor(letter);
			return paint("dim", letter);
		})
		.join("");

	const prefix = theme
		? `${theme.fg("dim", `${formatFooterPrefix(config)} `)}`
		: `${ANSI_DIM}${formatFooterPrefix(config)} ${ANSI_RESET}`;
	return `${prefix}${letters}`;
}
