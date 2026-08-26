import { describe, expect, it } from "bun:test";
import { appendGroupedReadUsageLines } from "./grouped-read-usage-prefix";

describe("appendGroupedReadUsageLines", () => {
	it("does not insert a separator when there is no usage", () => {
		const lines = ["title"];
		appendGroupedReadUsageLines(lines, []);
		expect(lines).toEqual(["title"]);
	});

	it("inserts a blank line then flush-left usage rows", () => {
		const lines = ["   └─ file.ts"];
		appendGroupedReadUsageLines(lines, ["2026-08-27 usage"]);
		expect(lines).toEqual(["   └─ file.ts", "", "2026-08-27 usage"]);
	});
});
