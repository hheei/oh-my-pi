import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "../../src/core/shared/sqlite";
import {
	createMemorySaveTool,
	markTurnTainted,
	reconcileTurnTaintHostEntry,
	SqliteTurnTaintStore,
	validateRememberResponse,
} from "../../src/agentmemory/inject-save";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agentmemory save and provenance", () => {
	it("reports saved only for a validated remember response and queues failed delivery", async () => {
		const queued: unknown[] = [];
		const tool = createMemorySaveTool({
			client: { remember: async () => ({ success: true, memory: { id: "mem-1" } }) } as never,
			project: "repo",
		});
		const saved = await tool.execute(
			"id",
			{ content: "fact" },
			new AbortController().signal,
			undefined,
			undefined as never,
		);
		expect(saved.details).toMatchObject({ status: "saved", id: "mem-1" });
		const queuedTool = createMemorySaveTool({
			client: { remember: async () => ({ success: false, memory: {} }) } as never,
			project: "repo",
			queue: async input => {
				queued.push(input);
				return { candidateHash: "new-row" };
			},
			drain: async candidateHash => {
				expect(candidateHash).toBe("new-row");
				return "queued";
			},
		});
		const queuedResult = await queuedTool.execute(
			"id",
			{ content: "fact" },
			new AbortController().signal,
			undefined,
			undefined as never,
		);
		expect(queuedResult.details).toMatchObject({ status: "queued" });
		expect(queued).toHaveLength(1);
	});

	it("reconciles only the pending taint for the persisted current turn", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "mctx-taint-reconcile-"));
		dirs.push(dir);
		const file = path.join(dir, "taint.sqlite");
		const db = new Database(file);
		const store = new SqliteTurnTaintStore(db, "agentmemory");
		markTurnTainted(store, "turn-a", "first recall");
		markTurnTainted(store, "turn-b", "second recall");

		reconcileTurnTaintHostEntry(db, "turn-b", "user-entry-b");

		expect(store.get("turn-a")?.hostEntryId).toBeUndefined();
		expect(store.get("turn-b")?.hostEntryId).toBe("user-entry-b");
		db.close();
	});

	it("keeps the configured project and agent scope when model args are supplied", async () => {
		const queued: unknown[] = [];
		const tool = createMemorySaveTool({
			client: { remember: async () => ({ success: true, memory: { id: "mem-1" } }) } as never,
			project: "configured-project",
			agentId: "configured-agent",
			queue: async input => void queued.push(input),
		});
		await tool.execute(
			"id",
			{ content: "fact", project: "model-project", agentId: "model-agent" } as never,
			new AbortController().signal,
			undefined,
			undefined as never,
		);
		expect(queued[0]).toMatchObject({ project: "configured-project", agentId: "configured-agent" });
	});

	it("rejects remember responses without a durable id", () => {
		expect(() => validateRememberResponse({ success: true, memory: {} } as never)).toThrow(
			"did not confirm persistence",
		);
	});
});
