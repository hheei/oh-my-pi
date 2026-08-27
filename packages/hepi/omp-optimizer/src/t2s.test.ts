import { describe, expect, test } from "bun:test";
import { convertInputText } from "./t2s.ts";

describe("optimizer t2s", () => {
	test("converts Traditional Chinese prose", () => {
		expect(convertInputText("甚麼設定需要幫忙？")).toBe("什么设定需要帮忙？");
	});

	test("preserves inline and fenced code", () => {
		const input = "請看 `甚麼`\n```ts\n甚麼設定\n```\n~~~txt\n最後設定\n~~~\n最後設定";
		expect(convertInputText(input)).toBe(
			"请看 `甚麼`\n```ts\n甚麼設定\n```\n~~~txt\n最後設定\n~~~\n最后设定",
		);
	});
});
