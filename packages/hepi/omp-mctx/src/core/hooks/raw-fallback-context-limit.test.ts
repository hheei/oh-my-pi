import { describe, expect, test } from "bun:test";
import { EmergencyFailClosedError, ENGINE_RECONNECTING_USER_MESSAGE } from "./emergency-fail-closed.ts";
import {
	isLoudTransformAbort,
	RawFallbackContextLimitError,
} from "./raw-fallback-context-limit.ts";

describe("raw-fallback context-limit refuse", () => {
	test("uses the calm reconnecting message and keeps token fields", () => {
		const error = new RawFallbackContextLimitError(900_000, 200_000);
		expect(error.message).toBe(ENGINE_RECONNECTING_USER_MESSAGE);
		expect(error.message).not.toContain("900");
		expect(error.estimatedTokens).toBe(900_000);
		expect(error.contextLimitTokens).toBe(200_000);
		expect(error.recoverable).toBe(true);
	});

	test("is never swallowed as a quiet transform abort", () => {
		expect(isLoudTransformAbort(new RawFallbackContextLimitError(1, 1), false)).toBe(true);
		expect(isLoudTransformAbort(new RawFallbackContextLimitError(1, 1), true)).toBe(true);
		expect(isLoudTransformAbort(new EmergencyFailClosedError("boom"), false)).toBe(true);
		expect(isLoudTransformAbort(new EmergencyFailClosedError("boom"), true)).toBe(false);
		expect(isLoudTransformAbort(new Error("ordinary"), false)).toBe(false);
	});
});
