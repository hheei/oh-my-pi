import { describe, expect, test } from "vitest";
import { HANDOFF_CONTEXT_TYPE } from "../../src/handoff/model";
import { convertEntriesToRawMessages } from "../../src/read-session-pi";

describe("convertEntriesToRawMessages handoff", () => {
	test("keeps destination Handoff Context as a skip-tagged historical message", () => {
		const messages = convertEntriesToRawMessages([
			{
				type: "custom_message",
				id: "handoff-1",
				customType: HANDOFF_CONTEXT_TYPE,
				content: "<handoff-context>summary</handoff-context>",
			},
		]);
		expect(messages).toEqual([
			{
				id: "handoff-1",
				role: "user",
				ordinal: 1,
				version: "handoff-1",
				skipTags: true,
				parts: [{ type: "text", text: "<handoff-context>summary</handoff-context>" }],
			},
		]);
	});

	test("does not allocate text or tool tags for Handoff Context", () => {
		const messages = convertEntriesToRawMessages([
			{
				type: "custom_message",
				id: "handoff-2",
				customType: HANDOFF_CONTEXT_TYPE,
				content: "visible handoff history",
			},
			{
				type: "message",
				id: "user-1",
				message: { role: "user", content: "continue" },
			},
		]);
		expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
		expect(messages[0]).toMatchObject({
			id: "handoff-2",
			skipTags: true,
		});
		expect(messages[1]).not.toMatchObject({ skipTags: true });
	});
});
