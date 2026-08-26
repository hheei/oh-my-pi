import { describe, expect, it } from "bun:test";
import { appendGroupedReadUsageLines, GROUPED_READ_USAGE_PREFIX } from "./grouped-read-usage-prefix";

describe("appendGroupedReadUsageLines", () => {
	it("does not insert a separator when there is no usage", () => {
		const lines = ["title"];
		appendGroupedReadUsageLines(lines, []);
		expect(lines).toEqual(["title"]);
	});

	it("inserts a blank line then title-column usage rows", () => {
		const lines = ["   └─ file.ts"];
		appendGroupedReadUsageLines(lines, [`${GROUPED_READ_USAGE_PREFIX}2026-08-27 usage`]);
		expect(lines).toEqual(["   └─ file.ts", "", " 2026-08-27 usage"]);
	});
});
