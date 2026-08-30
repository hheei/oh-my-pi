import { describe, expect, test } from "vitest";
import { HANDOFF_REQUEST_TYPE, hashBytes } from "../../src/handoff/model";
import {
	collectRecentLogicalMessages,
	freezeHandoffSnapshot,
	modelVisibleBranchFingerprint,
} from "../../src/handoff/snapshot";

describe("handoff snapshot", () => {
	test("recent five folds tool results into the next user turn", () => {
		const result = collectRecentLogicalMessages(
			[
				{
					type: "message",
					id: "u1",
					message: { role: "user", content: "one" },
				},
				{
					type: "message",
					id: "a1",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "c1", name: "read" }],
					},
				},
				{
					type: "message",
					id: "t1",
					message: {
						role: "toolResult",
						toolCallId: "c1",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
					},
				},
				{
					type: "message",
					id: "u2",
					message: { role: "user", content: "two" },
				},
			],
			[],
			5,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.messages).toHaveLength(3);
		const last = result.messages[2] as { role: string; parts: unknown[] };
		expect(last.role).toBe("user");
		expect(JSON.stringify(last.parts)).toContain("file body");
		expect(JSON.stringify(last.parts)).toContain("two");
	});

	test("fails closed on unknown model-visible roles", () => {
		const result = collectRecentLogicalMessages(
			[
				{
					type: "message",
					id: "x1",
					message: { role: "system", content: "nope" },
				},
			],
			[],
			5,
		);
		expect(result.ok).toBe(false);
	});

	test("branch fingerprint ignores handoff request entries", () => {
		const entries = [
			{ id: "m1", type: "message", message: { role: "user", content: "hi" } },
			{
				id: "h1",
				type: "custom",
				customType: HANDOFF_REQUEST_TYPE,
				data: { requestId: "req" },
			},
			{
				id: "c1",
				type: "custom_message",
				customType: "other",
				content: "visible",
			},
		];
		const fingerprint = modelVisibleBranchFingerprint(entries);
		expect(fingerprint).toBe(hashBytes("m1\nc1"));
	});

	test("freeze fails when the execute ceiling cannot hold the reserve", () => {
		const result = freezeHandoffSnapshot({
			sessionId: "sess",
			sessionPath: "/tmp/s.jsonl",
			projectIdentity: "/tmp",
			model: "anthropic/claude",
			thinkingLevel: "off",
			systemPrompt: "sys",
			toolInventory: "[]",
			memoryRevision: "mem",
			branchFingerprint: "branch",
			usableLimit: 4_000,
			executeCeiling: 2_000,
			prefixTokens: 1_000,
			compartments: [],
			entries: [
				{
					type: "message",
					id: "u1",
					message: { role: "user", content: "hello" },
				},
			],
			tags: [],
		});
		expect(result.ok).toBe(false);
	});
});
