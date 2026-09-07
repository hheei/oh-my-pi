import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../src/core/shared/sqlite";
import { closeQuietly } from "../../src/core/shared/sqlite-helpers";
import {
	claimOutboxRows,
	candidateHash,
	commitHistorianPublication,
	drainAgentMemoryOutbox,
	ensureAgentMemoryOutboxSchema,
	recoverFailedAgentMemoryOutbox,
	linkAgentMemoryObservation,
	resolveLinkedObservationId,
} from "../../src/agentmemory/outbox";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) closeQuietly(db);
});

function database(): Database {
	const db = new Database(":memory:");
	databases.push(db);
	ensureAgentMemoryOutboxSchema(db);
	return db;
}

const candidate = { project: "repo", type: "fact", content: "Use the stable API", concepts: ["api"] };

describe("agentmemory outbox", () => {
	it("reconciles host source entries to returned remote observation ids", () => {
		const db = database();
		linkAgentMemoryObservation(db, {
			sourceId: "host-1",
			sessionId: "remote-1",
			project: "repo",
			sourceKind: "prompt_submit",
			content: "fact",
			observationId: "obs-1",
		});
		const lookup = {
			sessionId: "remote-1",
			project: "repo",
			sourceKinds: ["prompt_submit"],
			content: "fact",
		};
		expect(resolveLinkedObservationId(db, { sourceId: "host-1", ...lookup })).toBe("obs-1");
		expect(resolveLinkedObservationId(db, { sourceId: "host-missing", ...lookup })).toBeUndefined();
		expect(
			resolveLinkedObservationId(db, { sourceId: "host-1", ...lookup, content: "stale output" }),
		).toBeUndefined();
	});
	it("rolls back the Window publication when outbox insertion fails", () => {
		const db = database();
		const result = () =>
			commitHistorianPublication(db, {
				candidate,
				writeWindow: () =>
					db.exec("CREATE TABLE window_publication (id TEXT PRIMARY KEY)") &&
					db.prepare("INSERT INTO window_publication VALUES ('w1')").run(),
			});
		result();
		db.exec(
			"CREATE TRIGGER fail_outbox BEFORE INSERT ON agentmemory_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END",
		);
		expect(() =>
			commitHistorianPublication(db, {
				candidate: { ...candidate, content: "second" },
				writeWindow: () => db.prepare("INSERT INTO window_publication VALUES ('w2')").run(),
			}),
		).toThrow();
		expect(db.prepare("SELECT * FROM window_publication").all()).toEqual([{ id: "w1" }]);
		expect(db.prepare("SELECT COUNT(*) AS count FROM agentmemory_outbox").get()).toEqual({ count: 1 });
	});

	it("allows only one live lease and recovers an expired lease", () => {
		const db = database();
		commitHistorianPublication(db, { candidate, writeWindow: () => undefined, now: 100 });
		expect(claimOutboxRows(db, "worker-a", { now: 100, leaseMs: 50 })).toHaveLength(1);
		expect(claimOutboxRows(db, "worker-b", { now: 110 })).toHaveLength(0);
		expect(claimOutboxRows(db, "worker-b", { now: 151 })).toHaveLength(1);
	});

	it("keeps remote failure retryable and marks validated success delivered", async () => {
		const db = database();
		commitHistorianPublication(db, { candidate, writeWindow: () => undefined, now: 100 });
		const failed = await drainAgentMemoryOutbox(
			db,
			{
				remember: async () => {
					throw new Error("offline");
				},
			} as never,
			{ owner: "worker", now: () => 200 },
		);
		expect(failed).toMatchObject({ retried: 1 });
		expect(db.prepare("SELECT state FROM agentmemory_outbox").get()).toEqual({ state: "pending" });
		const succeeded = await drainAgentMemoryOutbox(
			db,
			{ remember: async () => ({ success: true, memory: { id: "mem-1" } }) } as never,
			{ owner: "worker", now: () => 2_000 },
		);
		expect(succeeded.delivered).toBe(1);
		expect(db.prepare("SELECT state, delivered_at FROM agentmemory_outbox").get()).toMatchObject({
			state: "delivered",
			delivered_at: 2_000,
		});
	});

	it("uses scoped duplicate preflight without contacting remember", async () => {
		const db = database();
		commitHistorianPublication(db, { candidate, writeWindow: () => undefined });
		let called = false;
		const result = await drainAgentMemoryOutbox(
			db,
			{
				remember: async () => {
					called = true;
					return { success: true, memory: { id: "bad" } };
				},
			} as never,
			{
				owner: "worker",
				preflightDuplicate: async row => row.payload.project === "repo",
			},
		);
		expect(result.skipped).toBe(1);
		expect(called).toBe(false);
	});

	it("stops automatic retries at maxAttempts while retaining an inspection row", async () => {
		const db = database();
		commitHistorianPublication(db, { candidate, writeWindow: () => undefined, now: 100 });
		const failed = await drainAgentMemoryOutbox(
			db,
			{
				remember: async () => {
					throw new Error("offline");
				},
			} as never,
			{ owner: "worker", now: () => 200, maxAttempts: 1 },
		);
		expect(failed).toMatchObject({ failed: 1, retried: 0 });
		expect(db.prepare("SELECT state, payload_json FROM agentmemory_outbox").get()).toMatchObject({ state: "failed" });
	});

	it("recovers terminal rows on startup without losing at-least-once delivery", async () => {
		const db = database();
		commitHistorianPublication(db, { candidate, writeWindow: () => undefined });
		await drainAgentMemoryOutbox(
			db,
			{
				remember: async () => {
					throw new Error("offline");
				},
			} as never,
			{
				owner: "worker",
				maxAttempts: 1,
			},
		);
		expect(db.prepare("SELECT state FROM agentmemory_outbox").get()).toEqual({ state: "failed" });
		recoverFailedAgentMemoryOutbox(db, 500);
		const result = await drainAgentMemoryOutbox(
			db,
			{ remember: async () => ({ success: true, memory: { id: "recovered" } }) } as never,
			{ owner: "worker", now: () => 500, candidateHash: candidateHash(candidate) },
		);
		expect(result.delivered).toBe(1);
	});

	it("retries cold failed rows after their backoff without restart", async () => {
		const db = database();
		commitHistorianPublication(db, { candidate, writeWindow: () => undefined, now: 100 });
		await drainAgentMemoryOutbox(
			db,
			{
				remember: async () => {
					throw new Error("offline");
				},
			} as never,
			{
				owner: "worker",
				now: () => 100,
				maxAttempts: 1,
				backoffMs: () => 50,
			},
		);
		expect(db.prepare("SELECT state, next_attempt_at FROM agentmemory_outbox").get()).toEqual({
			state: "failed",
			next_attempt_at: 150,
		});
		const result = await drainAgentMemoryOutbox(
			db,
			{ remember: async () => ({ success: true, memory: { id: "cold-retry" } }) } as never,
			{ owner: "worker", now: () => 149, maxAttempts: 1 },
		);
		expect(result.delivered).toBe(0);
		const recovered = await drainAgentMemoryOutbox(
			db,
			{ remember: async () => ({ success: true, memory: { id: "cold-retry" } }) } as never,
			{ owner: "worker", now: () => 150, maxAttempts: 1 },
		);
		expect(recovered.delivered).toBe(1);
	});

	it("hashes canonical whitespace and sorted concept/file sets", () => {
		expect(
			candidateHash({
				project: "repo",
				type: "fact",
				content: "Use   the\n stable API",
				concepts: [" z ", "a"],
				files: ["src/b.ts", "src/a.ts"],
			}),
		).toBe(
			candidateHash({
				project: "repo",
				type: "fact",
				content: "Use the stable API",
				concepts: ["a", "z"],
				files: ["src/a.ts", "src/b.ts"],
			}),
		);
		expect(candidateHash({ ...candidate, sourceObservationIds: ["obs-a"] })).toBe(
			candidateHash({ ...candidate, sourceObservationIds: ["obs-b"] }),
		);
	});

	it("reports saved for an already delivered identical candidate without another write", async () => {
		const db = database();
		commitHistorianPublication(db, { candidate, writeWindow: () => undefined });
		let writes = 0;
		const client = {
			remember: async () => {
				writes++;
				return { success: true, memory: { id: "delivered" } };
			},
		} as never;
		const first = await drainAgentMemoryOutbox(db, client, { owner: "worker" });
		expect(first.delivered).toBe(1);
		const second = await drainAgentMemoryOutbox(db, client, {
			owner: "worker",
			candidateHash: candidateHash(candidate),
		});
		expect(second.skipped).toBe(1);
		expect(writes).toBe(1);
	});
});
