import { describe, expect, test } from "bun:test";
import { expandPercentReferences, extractPercentToken, getPercentSuggestions, normalizeConfig } from "./model";

const commands = [
	{ name: "skill:reader", source: "skill", path: "/skills/reader/SKILL.md", description: "Read sources", location: "user" },
	{ name: "skill:writer", source: "skill", path: "/skills/writer/SKILL.md", description: "Write clearly", location: "project" },
	{ name: "extension:other", source: "extension", path: "/other", description: "Other", location: "user" },
] as const;

describe("percent skill references", () => {
	test("expands known skill references while leaving unknown text unchanged", () => {
		expect(expandPercentReferences("Use %reader, then %missing.", commands)).toBe("Use /skills/reader/SKILL.md, then %missing.");
	});
	test("extracts only a percent token at a word boundary", () => {
		expect(extractPercentToken(["Use %rea"], 0, 8)).toEqual({ query: "rea", prefix: "%rea" });
		expect(extractPercentToken(["email%reader"], 0, 12)).toBeUndefined();
	});
	test("suggestions include skills only and honor limit", () => {
		expect(getPercentSuggestions(commands, "", 1).map(item => item.value)).toEqual(["%reader"]);
	});
	test("normalizes persisted settings at trust boundary", () => {
		expect(normalizeConfig({ enabled: false, maxSuggestions: 999 })).toEqual({ enabled: false, maxSuggestions: 50 });
	});
});
