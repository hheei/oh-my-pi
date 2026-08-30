import { describe, expect, it } from "vitest";
import type {
	ContextUsage,
	PendingOp,
	SchedulerDecision,
	SessionMeta,
	TagEntry,
} from "../../../src/core/features/types";

describe("magic-context types", () => {
	it("TagEntry has the expected shape", () => {
		const entry = {
			tagNumber: 1,
			messageId: "msg-abc",
			type: "message",
			status: "active",
			dropMode: "full",
			toolName: null,
			inputByteSize: 0,
			byteSize: 512,
			reasoningByteSize: 0,
			sessionId: "ses-xyz",
		} as TagEntry;

		expect(entry.tagNumber).toBe(1);
		expect(entry.type).toBe("message");
		expect(entry.status).toBe("active");
		expect(entry.dropMode).toBe("full");
	});

	it("TagEntry keeps dropped and compacted statuses", () => {
		const dropped: TagEntry["status"] = "dropped";
		const compacted: TagEntry["status"] = "compacted";

		expect(dropped).toBe("dropped");
		expect(compacted).toBe("compacted");
	});

	it("PendingOp is drop-only", () => {
		const op: PendingOp = {
			id: 1,
			sessionId: "ses-xyz",
			tagId: 42,
			operation: "drop",
			queuedAt: Date.now(),
		};

		expect(op.operation).toBe("drop");
	});

	it("SessionMeta has the expected shape", () => {
		const meta = {
			sessionId: "ses-xyz",
			lastResponseTime: Date.now(),
			cacheTtl: "5m",
			counter: 0,
			lastNudgeTokens: 0,
			lastNudgeBand: null,
			lastTransformError: null,
			isSubagent: false,
			lastContextPercentage: 0,
			lastInputTokens: 0,
			timesExecuteThresholdReached: 0,
			compartmentInProgress: false,
			systemPromptHash: "",
			systemPromptTokens: 0,
			clearedReasoningThroughTag: 0,
		} as SessionMeta;

		expect(meta.counter).toBe(0);
		expect(meta.isSubagent).toBe(false);
	});

	it("SchedulerDecision accepts execute and defer", () => {
		const execute: SchedulerDecision = "execute";
		const defer: SchedulerDecision = "defer";

		expect(execute).toBe("execute");
		expect(defer).toBe("defer");
	});

	it("ContextUsage has the expected shape", () => {
		const usage: ContextUsage = {
			percentage: 45.5,
			inputTokens: 10_000,
		};

		expect(usage.percentage).toBe(45.5);
		expect(usage.inputTokens).toBe(10_000);
	});
});
