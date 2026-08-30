import { describe, expect, test } from "bun:test";
import { isDuplicate, resetDedup } from "./dedup.ts";

describe("isDuplicate", () => {
	test("repeats within window", () => {
		resetDedup();
		expect(isDuplicate("prompt_submit:s:hello")).toBe(false);
		expect(isDuplicate("prompt_submit:s:hello")).toBe(true);
		expect(isDuplicate("prompt_submit:s:other")).toBe(false);
	});
});
