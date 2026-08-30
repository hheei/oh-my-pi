import { describe, expect, test } from "bun:test";
import { shouldStartOmpMctx } from "./settings.ts";

describe("shouldStartOmpMctx", () => {
	test("defaults off", () => {
		expect(shouldStartOmpMctx({})).toBe(false);
		expect(shouldStartOmpMctx({ enabled: false })).toBe(false);
		expect(shouldStartOmpMctx({ enabled: "true" })).toBe(false);
	});

	test("starts only when enabled is boolean true", () => {
		expect(shouldStartOmpMctx({ enabled: true })).toBe(true);
	});
});
