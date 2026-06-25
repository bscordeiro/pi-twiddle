import { describe, expect, it } from "vitest";
import { formatFooterLabel, formatFooterShimmerFrame } from "./footer.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

describe("formatFooterLabel", () => {
	it("shows manual mode without token savings", () => {
		expect(formatFooterLabel({ auto: false })).toBe("~ Twiddle");
	});

	it("shows auto mode without token savings", () => {
		expect(formatFooterLabel({ auto: true })).toBe("≈ Twiddle");
	});
});

describe("formatFooterShimmerFrame", () => {
	it("preserves manual label text", () => {
		expect(stripAnsi(formatFooterShimmerFrame({ auto: false }, 1))).toBe("~ Twiddle");
	});

	it("preserves auto label text", () => {
		expect(stripAnsi(formatFooterShimmerFrame({ auto: true }, 1))).toBe("≈ Twiddle");
	});

	it("moves the highlight between frames", () => {
		expect(formatFooterShimmerFrame({ auto: false }, 1)).not.toBe(
			formatFooterShimmerFrame({ auto: false }, 2),
		);
	});
});
