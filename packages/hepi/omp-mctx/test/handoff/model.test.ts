import { describe, expect, test } from "vitest";
import {
	applyHandoffAuthorityGuard,
	assertPayloadLimit,
	buildCompletionPrompt,
	buildHandoffCompletionMessages,
	deriveSummaryReserve,
	detectConversationLanguage,
	escapeXml,
	fenceMatches,
	formatHandoffBusyWarning,
	formatHandoffWarning,
	HANDOFF_PAYLOAD_LIMIT_BYTES,
	HANDOFF_SUMMARY_RESERVE_MIN,
	HANDOFF_SYSTEM_GUARD,
	type HandoffFence,
	handoffContextContent,
	planHandoffBudget,
	reduceHandoffPhase,
	renderHandoffContextXml,
	serializeRecentMessages,
	stripHandoffTags,
	validateHandoffSummary,
} from "../../src/handoff/model";

function fence(overrides: Partial<HandoffFence> = {}): HandoffFence {
	return {
		projectIdentity: "/tmp/project",
		sessionId: "sess-1",
		sessionPath: "/tmp/source.jsonl",
		model: "anthropic/claude",
		thinkingLevel: "medium",
		systemPromptHash: "sys",
		toolInventoryHash: "tools",
		memoryRevision: "mem",
		compartmentRevision: "comp",
		sessionHistoryHash: "hist",
		recentFiveHash: "recent",
		branchFingerprint: "branch",
		...overrides,
	};
}

describe("handoff model", () => {
	test("summary reserve is 10% capped at 4096 and fails below 512", () => {
		expect(deriveSummaryReserve(200_000)).toBe(4096);
		expect(deriveSummaryReserve(20_000)).toBe(2000);
		expect(deriveSummaryReserve(4000)).toBe(400);
	});

	test("budget keeps summary and recent five, then fails when history budget is gone", () => {
		const ok = planHandoffBudget({
			usableLimit: 200_000,
			executeCeiling: 100_000,
			prefixTokens: 2_000,
			recentTokens: 1_000,
			estimateTokens: (text) => Math.ceil(text.length / 4),
		});
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.plan.summaryReserve).toBe(4096);
			expect(ok.plan.historyBudget).toBeGreaterThan(0);
		}

		const fail = planHandoffBudget({
			usableLimit: 8_000,
			executeCeiling: 4_000,
			prefixTokens: 3_000,
			recentTokens: 500,
			estimateTokens: () => 100,
		});
		expect(fail.ok).toBe(false);
		if (!fail.ok) {
			expect(fail.reason).toContain("summary reserve");
		}
	});

	test("payload limit counts serialized bytes including images", () => {
		expect(assertPayloadLimit({ text: "ok" }, "payload")).toBeUndefined();
		const huge = "x".repeat(HANDOFF_PAYLOAD_LIMIT_BYTES + 1);
		expect(assertPayloadLimit({ data: huge }, "Handoff Context")).toContain("above the");
	});

	test("phase reducer allows only the documented transitions", () => {
		expect(reduceHandoffPhase(undefined, "requested").ok).toBe(true);
		expect(reduceHandoffPhase(undefined, "snapshot-ready").ok).toBe(false);
		expect(reduceHandoffPhase("requested", "snapshot-ready").ok).toBe(true);
		expect(reduceHandoffPhase("snapshot-ready", "summary-ready").ok).toBe(true);
		expect(reduceHandoffPhase("summary-ready", "replacement-started").ok).toBe(true);
		expect(reduceHandoffPhase("replacement-started", "snapshot-ready").ok).toBe(false);
		expect(reduceHandoffPhase("failed", "requested").ok).toBe(false);
		expect(reduceHandoffPhase("requested", "cancelled").ok).toBe(true);
		expect(reduceHandoffPhase("snapshot-ready", "superseded").ok).toBe(true);
	});

	test("serializes text, images, and tool evidence while dropping reasoning", () => {
		const result = serializeRecentMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "see this §12§ file" },
					{ type: "image", mimeType: "image/png", data: "abcd" },
				],
			},
			{
				role: "assistant",
				parts: [
					{ type: "thinking", thinking: "secret" },
					{ type: "text", text: "done" },
					{
						type: "toolCall",
						name: "read",
						arguments: { path: "a.ts" },
						result: "ok",
					},
				],
			},
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.messages[0]?.text).toBe("see this  file");
		expect(result.messages[0]?.images).toEqual([{ mimeType: "image/png", data: "abcd" }]);
		expect(result.messages[1]?.text).toContain("tool read");
		expect(result.messages[1]?.text).not.toContain("secret");
		expect(result.messages[1]?.text).toContain("done");
	});

	test("fails closed on unknown model-visible parts", () => {
		const result = serializeRecentMessages([
			{ role: "user", parts: [{ type: "widget", payload: true }] },
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("widget");
	});

	test("XML builder escapes dynamic text and keeps a stable envelope", () => {
		const xml = renderHandoffContextXml({
			sessionId: `s<"id">`,
			model: "anthropic/claude",
			generatedAt: "2026-01-01T00:00:00.000Z",
			sessionHistory: "<old>&",
			recentMessages: [{ role: "user", text: "hello <world>", images: [] }],
			summary: "keep going",
		});
		expect(xml).toContain("<handoff-context>");
		expect(xml).toContain(escapeXml(`s<"id">`));
		expect(xml).toContain("&lt;old&gt;&amp;");
		expect(xml).toContain("hello &lt;world&gt;");
		expect(xml).not.toContain("<old>&");
	});

	test("summary validator accepts only terminal stop, non-empty text, and budget", () => {
		expect(
			validateHandoffSummary({
				text: "ok",
				stopReason: "stop",
				tokenCount: 10,
				budgetTokens: 20,
			}),
		).toBeUndefined();
		expect(
			validateHandoffSummary({
				text: "ok",
				stopReason: "length",
				tokenCount: 10,
				budgetTokens: 20,
			}),
		).toContain("length");
		expect(
			validateHandoffSummary({
				text: "   ",
				stopReason: "stop",
				tokenCount: 1,
				budgetTokens: 20,
			}),
		).toContain("no summary");
		expect(
			validateHandoffSummary({
				text: "ok",
				stopReason: "stop",
				tokenCount: 30,
				budgetTokens: 20,
			}),
		).toContain("above the");
	});

	test("fence matches every stored field", () => {
		const a = fence();
		expect(fenceMatches(a, fence())).toBe(true);
		expect(fenceMatches(a, fence({ memoryRevision: "other" }))).toBe(false);
	});

	test("warning contract names outcome, stage, source, and next action", () => {
		const warning = formatHandoffWarning({
			outcome: "failed",
			stage: "completion",
			reason: "provider timeout",
			requestId: "req-1",
			model: "anthropic/claude",
			sourceAvailable: true,
			nextAction: "new-request",
		});
		expect(warning.title).toBe("Handoff failed during completion");
		expect(warning.text).toContain("provider timeout");
		expect(warning.text).toContain("Request: req-1");
		expect(warning.text).toContain("source session is still available");
		expect(warning.text).toContain("start a new request");

		const busy = formatHandoffBusyWarning({
			holderRequestId: "req-2",
			stage: "summarizing",
			expiresAt: 10_000,
			now: 4_000,
		});
		expect(busy.title).toBe("Handoff failed during busy");
		expect(busy.text).toContain("req-2");
		expect(busy.text).toContain("6s");
	});

	test("completion prompt covers required topics without forcing headings", () => {
		const prompt = buildCompletionPrompt({
			language: "zh-CN",
			reserveTokens: 512,
		});
		expect(prompt).toContain("no tools");
		expect(prompt).toContain("zh-CN");
		expect(prompt).toContain("Current objective");
		expect(prompt).not.toContain("## Current Objective");
	});

	test("language follows settings, then recent conversation script", () => {
		expect(detectConversationLanguage([], "ja")).toBe("ja");
		expect(detectConversationLanguage([{ role: "user", text: "继续做", images: [] }])).toBe(
			"zh-CN",
		);
		expect(detectConversationLanguage([{ role: "user", text: "keep going", images: [] }])).toBe(
			"en",
		);
	});

	test("handoff content keeps images as typed parts after the XML", () => {
		const content = handoffContextContent({
			xml: "<handoff-context/>",
			images: [{ mimeType: "image/png", data: "abcd" }],
		});
		expect(content[0]).toEqual({ type: "text", text: "<handoff-context/>" });
		expect(content[1]).toEqual({
			type: "image",
			mimeType: "image/png",
			data: "abcd",
		});
	});

	test("tag strip removes Magic Context notation", () => {
		expect(stripHandoffTags("see §12§ and [dropped 3]")).not.toContain("§12§");
	});

	test("reserve minimum is the documented 512 tokens", () => {
		expect(HANDOFF_SUMMARY_RESERVE_MIN).toBe(512);
	});

	test("completion messages are valid pi-ai Context messages", () => {
		const messages = buildHandoffCompletionMessages({
			sessionHistory: "old work",
			recentMessages: [
				{ role: "user", text: "add helper", images: [] },
				{ role: "assistant", text: "added helper", images: [] },
			],
			prompt: "summarize",
			model: { api: "openai-completions", provider: "cx", id: "grok-4.6" },
			now: 10,
		});
		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({
			role: "user",
			content: "old work",
			timestamp: 10,
		});
		const assistant = messages[2];
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role !== "assistant") return;
		expect(assistant.content).toEqual([{ type: "text", text: "added helper" }]);
		expect(assistant.api).toBe("openai-completions");
		expect(assistant.stopReason).toBe("stop");
		expect(assistant.timestamp).toBe(10);
		expect(messages[3]).toEqual({
			role: "user",
			content: "summarize",
			timestamp: 10,
		});
	});

	test("authority guard is injected once and only when a Handoff Context exists", () => {
		expect(applyHandoffAuthorityGuard("base", false)).toBe("base");
		const once = applyHandoffAuthorityGuard("base", true);
		expect(once).toContain(HANDOFF_SYSTEM_GUARD);
		expect(applyHandoffAuthorityGuard(once, true)).toBe(once);
	});
});
