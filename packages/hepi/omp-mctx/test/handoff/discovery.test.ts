import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { discoverContinuations } from "../../src/handoff/command";
import { HANDOFF_ATTEMPT_TYPE, HANDOFF_CONTEXT_TYPE } from "../../src/handoff/model";

function writeSession(dir: string, name: string, entries: unknown[]): string {
	const path = join(dir, name);
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
	return path;
}

describe("handoff discovery", () => {
	test("switches to the single valid continuation and refuses multiples", async () => {
		const dir = mkdtempSync(join(tmpdir(), "handoff-disc-"));
		const source = writeSession(dir, "source.jsonl", []);
		const valid = writeSession(dir, "child.jsonl", [
			{
				type: "custom_message",
				customType: HANDOFF_CONTEXT_TYPE,
				details: {
					requestId: "req-1",
					sourceSessionId: "sess",
					sourcePath: source,
					projectIdentity: dir,
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
				content: "<handoff-context/>",
			},
		]);
		const found = await discoverContinuations(
			{
				cwd: dir,
				sessionManager: {
					list: async () => [{ path: valid, parentSessionPath: source }],
				},
			} as never,
			source,
			"req-1",
		);
		expect(found).toEqual({ ok: true, switchTo: valid });

		const second = writeSession(dir, "child-2.jsonl", [
			{
				type: "custom_message",
				customType: HANDOFF_CONTEXT_TYPE,
				details: {
					requestId: "req-1",
					sourceSessionId: "sess",
					sourcePath: source,
					projectIdentity: dir,
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
				content: "<handoff-context/>",
			},
		]);
		const conflict = await discoverContinuations(
			{
				cwd: dir,
				sessionManager: {
					list: async () => [
						{ path: valid, parentSessionPath: source },
						{ path: second, parentSessionPath: source },
					],
				},
			} as never,
			source,
			"req-1",
		);
		expect(conflict.ok).toBe(false);
	});

	test("finalizes one unfinished attempt and treats a failed attempt as terminal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "handoff-att-"));
		const source = writeSession(dir, "source.jsonl", []);
		const unfinished = writeSession(dir, "attempt.jsonl", [
			{
				type: "custom",
				customType: HANDOFF_ATTEMPT_TYPE,
				data: {
					requestId: "req-2",
					phase: "attempt-started",
					sourcePath: source,
					startedAt: "now",
				},
			},
		]);
		const started = await discoverContinuations(
			{
				cwd: dir,
				sessionManager: {
					list: async () => [{ path: unfinished, parentSessionPath: source }],
				},
			} as never,
			source,
			"req-2",
		);
		expect(started).toEqual({ ok: true, finalize: unfinished });

		const failed = writeSession(dir, "failed.jsonl", [
			{
				type: "custom",
				customType: HANDOFF_ATTEMPT_TYPE,
				data: {
					requestId: "req-2",
					phase: "attempt-failed",
					sourcePath: source,
					startedAt: "now",
					category: "replacement",
					reason: "prefix drift",
				},
			},
		]);
		const terminal = await discoverContinuations(
			{
				cwd: dir,
				sessionManager: {
					list: async () => [{ path: failed, parentSessionPath: source }],
				},
			} as never,
			source,
			"req-2",
		);
		expect(terminal.ok).toBe(false);
	});
});
