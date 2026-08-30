import { afterEach, describe, expect, test } from "vitest";
import {
	clearModelsDevCache,
	getModelsDevCacheState,
	getSdkContextLimit,
	getSdkInputLimit,
	isSaneLimit,
	resolveLimit,
	setOutputReserveConfig,
} from "../../../src/core/shared/models-dev-cache";

afterEach(() => {
	clearModelsDevCache();
	setOutputReserveConfig(undefined);
});

describe("Pi model limits", () => {
	test("accepts sane Pi runtime limits", () => {
		expect(isSaneLimit(20_000)).toBe(true);
		expect(isSaneLimit(3_000_000)).toBe(true);
		expect(isSaneLimit(19_999)).toBe(false);
		expect(isSaneLimit(3_000_001)).toBe(false);
	});

	test("uses the input quota when it is narrower than context", () => {
		expect(resolveLimit({ context: 200_000, input: 160_000 }, "anthropic", "claude")).toBe(160_000);
	});

	test("reserves output quota within the context floor", () => {
		expect(resolveLimit({ context: 200_000, output: 64_000 }, "anthropic", "claude")).toBe(150_000);
	});

	test("honors configured output reserve", () => {
		setOutputReserveConfig({ default: 10_000, "anthropic/claude": 20_000 });
		expect(resolveLimit({ context: 200_000, output: 64_000 }, "anthropic", "claude")).toBe(180_000);
	});

	test("has no core catalog fallback", () => {
		expect(getSdkContextLimit()).toBeUndefined();
		expect(getSdkInputLimit()).toBeUndefined();
		expect(getModelsDevCacheState()).toEqual({ apiLoaded: false, apiCount: 0, apiAgeMs: -1 });
	});
});
