import { describe, expect, test } from "bun:test";
import { formatSearchResults, normalizeBaseUrl } from "./format.ts";

describe("formatSearchResults", () => {
	test("empty", () => {
		expect(formatSearchResults([])).toBe("No relevant memories found.");
	});

	test("uses observation title narrative and score", () => {
		const text = formatSearchResults([
			{
				combinedScore: 1.05,
				observation: { title: "mctx-cutover-probe", narrative: "cutover", type: "decision" },
			},
		]);
		expect(text).toContain("mctx-cutover-probe");
		expect(text).toContain("decision");
		expect(text).toContain("1.050");
		expect(text).toContain("cutover");
	});
});

describe("normalizeBaseUrl", () => {
	test("strips trailing slashes", () => {
		expect(normalizeBaseUrl("http://127.0.0.1:3111/")).toBe("http://127.0.0.1:3111");
	});
});
