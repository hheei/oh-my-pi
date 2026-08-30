import { describe, expect, it } from "vitest";
import {
	deriveMinForceEligibleTokens,
	deriveProtectedTailTokenTarget,
} from "../../../src/core/hooks/protected-tail-boundary";
import { buildTrueRawTokenIndexFromTokenCountsForTest } from "../../../src/core/hooks/read-session-true-raw-tokens";

describe("protected-tail boundary", () => {
	it("finds suffix starts from token counts", () => {
		const index = buildTrueRawTokenIndexFromTokenCountsForTest("session", [100, 100, 100]);
		expect(index.findSuffixStartForTokens(150)).toBe(2);
		expect(index.findSuffixStartForTokens(300)).toBe(1);
		expect(index.findSuffixStartForTokens(0)).toBe(4);
	});

	it("clamps protected-tail size for small contexts", () => {
		const boundary = deriveProtectedTailTokenTarget({
			contextLimit: 8_000,
			executeThresholdPercentage: 65,
			usagePercentage: 30,
		});
		expect(boundary.ceilingN).toBe(2_080);
		expect(boundary.N).toBe(2_000);
		expect(boundary.effectiveFloor).toBeLessThanOrEqual(boundary.ceilingN);
	});

	it("scales force eligibility with tail size", () => {
		expect(deriveMinForceEligibleTokens(8)).toBe(1);
		expect(deriveMinForceEligibleTokens(16_000)).toBe(1_000);
	});
});
