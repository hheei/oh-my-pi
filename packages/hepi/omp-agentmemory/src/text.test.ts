import { describe, expect, test } from "bun:test";
import { getLastAssistantText, getText } from "./text.ts";

describe("getText", () => {
	test("joins text blocks", () => {
		expect(getText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
	});
});

describe("getLastAssistantText", () => {
	test("returns last assistant text block", () => {
		expect(
			getLastAssistantText([
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "text", text: "saved" }] },
			]),
		).toBe("saved");
	});
});
