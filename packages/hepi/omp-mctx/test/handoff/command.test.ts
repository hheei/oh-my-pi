import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { initializeDatabase } from "../../src/core/features/storage-db";
import {
	publishHandoffContext,
	registerHandoffCommand,
	runHandoffCommand,
} from "../../src/handoff/command";
import { acquireHandoffLease } from "../../src/handoff/lease";
import { HANDOFF_CONTEXT_TYPE } from "../../src/handoff/model";

function createDb(): Database {
	const db = new Database(":memory:");
	initializeDatabase(db);
	initializeDatabase(db);
	return db;
}

function ctx(warnings: string[], overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/tmp/project",
		model: { provider: "anthropic", id: "claude", contextWindow: 200_000 },
		hasPendingMessages: () => false,
		waitForIdle: async () => undefined,
		ui: {
			notify(text: string) {
				warnings.push(text);
			},
		},
		sessionManager: {
			isPersisted: () => true,
			getSessionFile: () => "/tmp/project/source.jsonl",
			getSessionId: () => "sess-1",
			getBranch: () => [],
			getEntries: () => [],
		},
		...overrides,
	};
}

describe("handoff command", () => {
	test("publishes Handoff Context through sendMessage without starting a turn", async () => {
		const sent: Array<{ message: unknown; options: unknown }> = [];
		const dir = await mkdtemp(join(tmpdir(), "handoff-publish-"));
		const sessionFile = join(dir, "dest.jsonl");
		try {
			await publishHandoffContext(
				{
					async sendMessage(message: unknown, options?: unknown) {
						sent.push({ message, options });
					},
					sessionManager: {
						getSessionFile: () => sessionFile,
						getHeader: () => ({
							type: "session",
							id: "dest",
							cwd: "/tmp",
							timestamp: 0,
						}),
						getEntries: () =>
							[
								{
									type: "custom_message",
									customType: HANDOFF_CONTEXT_TYPE,
									content: "<handoff-context/>",
								},
							] as never,
					},
				} as never,
				"<handoff-context/>",
				{
					requestId: "req-1",
					sourcePath: "/tmp/source.jsonl",
					sourceSessionId: "sess-1",
					projectIdentity: "/tmp/project",
					model: "anthropic/claude",
					thinkingLevel: "off",
					generatedAt: "2026-01-01T00:00:00.000Z",
					images: [],
				} as never,
			);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.options).toEqual({ triggerTurn: false });
			expect(sent[0]?.message).toEqual(
				expect.objectContaining({
					customType: HANDOFF_CONTEXT_TYPE,
					display: true,
				}),
			);
			const persisted = await readFile(sessionFile, "utf8");
			expect(persisted).toContain(HANDOFF_CONTEXT_TYPE);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("does not overwrite entry renderers registered by runtime startup", () => {
		const entryTypes: string[] = [];
		const messageTypes: string[] = [];
		registerHandoffCommand(
			{
				registerCommand() {},
				registerEntryRenderer(type: string) {
					entryTypes.push(type);
				},
				registerMessageRenderer(type: string) {
					messageTypes.push(type);
				},
			} as never,
			{} as never,
		);
		expect(entryTypes).toEqual([]);
		expect(messageTypes).toEqual([]);
	});

	test("rejects arguments before acquiring a lease", async () => {
		const db = createDb();
		const warnings: string[] = [];
		try {
			await runHandoffCommand(
				{} as never,
				{
					db,
					compactionOff: false,
					historianModel: "anthropic/claude",
				} as never,
				ctx(warnings) as never,
				"please continue",
			);
			expect(warnings.join("\n")).toContain("does not accept arguments");
			expect(acquireHandoffLease(db, "sess-1", "probe", "req", "preparing")).not.toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	test("empty-session wrapup is already current then completion fails closed", async () => {
		const db = createDb();
		const warnings: string[] = [];
		const appended: unknown[] = [];
		try {
			await runHandoffCommand(
				{
					appendEntry(_type: string, data: unknown) {
						appended.push(data);
					},
					getAllTools: () => [],
				} as never,
				{
					db,
					compactionOff: false,
					historianModel: "anthropic/claude",
					runner: {
						run: async () => {
							throw new Error("runner must not start when wrapup is already current");
						},
					},
				} as never,
				{
					...ctx(warnings),
					getSystemPrompt: () => "system",
					thinkingLevel: "off",
				} as never,
				"",
			);
			expect(warnings.join("\n")).toContain("The source session is still available.");
			expect(warnings.join("\n")).toContain("extension lifecycle is not started");
			expect(appended.some((entry) => JSON.stringify(entry).includes("failed"))).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	test("shows the current holder when the lease is already taken", async () => {
		const db = createDb();
		const warnings: string[] = [];
		try {
			expect(acquireHandoffLease(db, "sess-1", "other", "req-hold", "summarizing")).not.toBeNull();
			await runHandoffCommand(
				{} as never,
				{
					db,
					compactionOff: false,
					historianModel: "anthropic/claude",
				} as never,
				ctx(warnings) as never,
				"",
			);
			expect(warnings.join("\n")).toContain("req-hold");
			expect(warnings.join("\n")).toContain("summarizing");
		} finally {
			closeQuietly(db);
		}
	});
});
