import { describe, expect, test } from "bun:test";
import {
	findLatestAssistantReasoningMutationExemptMessage,
	stripReasoningFromMergedAssistants,
} from "./strip-content.ts";
import type { MessageLike } from "./tag-messages.ts";

function assistant(parts: MessageLike["parts"]): MessageLike {
	return { info: { role: "assistant" }, parts };
}

describe("findLatestAssistantReasoningMutationExemptMessage", () => {
	test("skips metadata-only trailing assistant shells", () => {
		const live = assistant([
			{ type: "reasoning", text: "think" },
			{ type: "text", text: "answer" },
		]);
		const shell = assistant([{ type: "step-finish" }]);
		expect(findLatestAssistantReasoningMutationExemptMessage([live, shell])).toBe(live);
	});
});

describe("stripReasoningFromMergedAssistants", () => {
	test("does not strip the latest visible assistant", () => {
		const latest = assistant([
			{ type: "reasoning", text: "keep me" },
			{ type: "text", text: "done" },
		]);
		const earlier = assistant([
			{ type: "reasoning", text: "old think" },
			{ type: "text", text: "mid" },
			{ type: "reasoning", text: "later think" },
		]);
		stripReasoningFromMergedAssistants([earlier, latest], "anthropic");
		const kept = latest.parts.some((part) => {
			if (!part || typeof part !== "object") return false;
			const rec = part as { type?: string; text?: string };
			return rec.type === "reasoning" && rec.text === "keep me";
		});
		expect(kept).toBe(true);
	});
});
