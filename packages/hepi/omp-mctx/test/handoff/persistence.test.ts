import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	HANDOFF_ATTEMPT_TYPE,
	HANDOFF_CONTEXT_TYPE,
	HANDOFF_REQUEST_TYPE,
	type HandoffRequestRecord,
} from "../../src/handoff/model";
import {
	appendRequestPhase,
	latestRequest,
	parseHandoffEntries,
	parseHandoffSessionFile,
} from "../../src/handoff/persistence";

function request(
	overrides: Partial<HandoffRequestRecord> & Pick<HandoffRequestRecord, "requestId" | "phase">,
): HandoffRequestRecord {
	return {
		stage: "preparing",
		createdAt: "1",
		...overrides,
	};
}

describe("handoff persistence", () => {
	test("parses request, attempt, and context entries from mixed JSONL", () => {
		const parsed = parseHandoffEntries([
			{ type: "message", id: "m1" },
			{
				type: "custom",
				customType: HANDOFF_REQUEST_TYPE,
				data: request({ requestId: "req-1", phase: "summary-ready" }),
			},
			{
				type: "custom",
				customType: HANDOFF_ATTEMPT_TYPE,
				data: {
					requestId: "req-1",
					phase: "attempt-started",
					sourcePath: "/tmp/source.jsonl",
					startedAt: "now",
				},
			},
			{
				type: "custom_message",
				customType: HANDOFF_CONTEXT_TYPE,
				details: {
					requestId: "req-1",
					sourceSessionId: "sess-1",
					sourcePath: "/tmp/source.jsonl",
					projectIdentity: "/tmp",
					model: "anthropic/claude",
					generatedAt: "now",
					tokens: {
						usableLimit: 1,
						executeCeiling: 1,
						prefixTokens: 1,
						summaryReserve: 1,
						recentTokens: 1,
						historyTokens: 1,
						wrapperTokens: 1,
					},
				},
				content: [{ type: "text", text: "<handoff-context/>" }],
			},
		]);
		expect(parsed.requests).toHaveLength(1);
		expect(parsed.attempts).toHaveLength(1);
		expect(parsed.contexts).toHaveLength(1);
		expect(parsed.contexts[0]?.xml).toBe("<handoff-context/>");
		expect(latestRequest(parsed.requests)?.phase).toBe("summary-ready");
	});

	test("append-only reducer refuses to revive a terminal request", () => {
		const first = appendRequestPhase(
			undefined,
			request({ requestId: "req-1", phase: "requested" }),
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const cancelled = appendRequestPhase(
			first.record,
			request({ requestId: "req-1", phase: "cancelled" }),
		);
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) return;
		const revived = appendRequestPhase(
			cancelled.record,
			request({ requestId: "req-1", phase: "requested" }),
		);
		expect(revived.ok).toBe(false);
	});

	test("a live request cannot change requestId", () => {
		const live = request({ requestId: "req-1", phase: "snapshot-ready" });
		const changed = appendRequestPhase(
			live,
			request({ requestId: "req-2", phase: "summary-ready" }),
		);
		expect(changed.ok).toBe(false);
	});

	test("file parser skips corrupt lines", () => {
		const dir = mkdtempSync(join(tmpdir(), "handoff-jsonl-"));
		const file = join(dir, "session.jsonl");
		writeFileSync(
			file,
			[
				"{not json",
				JSON.stringify({
					type: "custom",
					customType: HANDOFF_REQUEST_TYPE,
					data: request({ requestId: "req-9", phase: "requested" }),
				}),
			].join("\n"),
		);
		const parsed = parseHandoffSessionFile(file);
		expect(parsed.requests[0]?.requestId).toBe("req-9");
	});
});
