import { afterEach, describe, expect, test } from "bun:test";
import { AgentMemoryClient } from "../../src/agentmemory/client";
import type {
	AgentMemoryClientPort,
	AgentMemoryRequestOptions,
	HealthResult,
	LessonSearchInput,
	LessonSearchResult,
	Memory,
	MemoryListInput,
	MemoryPage,
	ObserveInput,
	ObserveResult,
	RememberInput,
	RememberResult,
	SearchInput,
	SearchResult,
	Session,
	StartSessionInput,
	StartSessionResult,
} from "../../src/agentmemory/client";
import { admitAutomaticRecall, applyAdmittedRecallToMessages } from "../../src/agentmemory/recall-admission";
import { listActiveBranchRecallEvents } from "../../src/agentmemory/recall-ledger";
import { presentAdmittedRecall } from "../../src/agentmemory/recall-presentation";
import { ensureContextProjectionSchema, readContextProjection } from "../../src/core/features/context-projection";
import {
	publishContextProjection,
	withdrawProjectionPrivacy,
} from "../../src/core/features/context-projection-coordinator";
import { ensureRecallLedgerSchema } from "../../src/agentmemory/recall-ledger";
import { Database } from "../../src/core/shared/sqlite";

const databases: Database[] = [];
const decoder = new TextDecoder();

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function createDb(): Database {
	const db = new Database(":memory:");
	ensureRecallLedgerSchema(db);
	ensureContextProjectionSchema(db);
	databases.push(db);
	return db;
}

function fakeClient(
	search: (input: SearchInput, options?: AgentMemoryRequestOptions) => Promise<SearchResult>,
): AgentMemoryClientPort {
	return {
		health: (): Promise<HealthResult> => Promise.resolve({ status: "ok" }),
		startSession: (_input: StartSessionInput): Promise<StartSessionResult> =>
			Promise.resolve({ sessionId: "session" }),
		observe: (_input: ObserveInput): Promise<ObserveResult> => Promise.resolve({}),
		search,
		searchLessons: (_input: LessonSearchInput): Promise<LessonSearchResult> => Promise.resolve({ lessons: [] }),
		getMemory: (_id: string): Promise<Memory | null> => Promise.resolve(null),
		listSessions: (): Promise<Session[]> => Promise.resolve([]),
		listMemories: (_input?: MemoryListInput): Promise<MemoryPage> => Promise.resolve({ memories: [] }),
		remember: (_input: RememberInput): Promise<RememberResult> =>
			Promise.resolve({ success: true, memory: { id: "remembered" } }),
		endSession: (_sessionId: string): Promise<void> => Promise.resolve(),
	};
}

const contract = { modelDigest: "model-1", systemDigest: "system-1", toolsDigest: "tools-1" };

describe("recorded-wire automatic recall", () => {
	test("first turn, retry, and later user entry keep stable projection bytes", async () => {
		const db = createDb();
		let searches = 0;
		const client = fakeClient(input => {
			searches += 1;
			const content = input.query.includes("rollback") ? "rollback with blue-green" : "deploy on friday";
			return Promise.resolve({ memories: [{ id: searches === 1 ? "m1" : "m2", content, project: "project" }] });
		});
		const firstMessages = [{ id: "u1", role: "user", content: "when do we deploy?" }];
		const first = await admitAutomaticRecall({
			db,
			sessionId: "session",
			messages: firstMessages,
			userEntryAnchor: "u1",
			query: "when do we deploy?",
			scope: { project: "project" },
			client,
		});
		expect(first.status).toBe("admitted");
		const withRecall = applyAdmittedRecallToMessages(firstMessages, first.event!);
		const published = publishContextProjection(db, {
			sessionId: "session",
			messages: withRecall,
			contract,
		});
		expect(published.action).toBe("bootstrap");
		const firstBody = decoder.decode(readContextProjection(db, "session", "main")!.body);

		const retry = await admitAutomaticRecall({
			db,
			sessionId: "session",
			messages: firstMessages,
			userEntryAnchor: "u1",
			query: "when do we deploy?",
			scope: { project: "project" },
			client,
		});
		expect(retry.status).toBe("reused");
		expect(retry.event?.eventId).toBe(first.event?.eventId);
		const retryPublished = publishContextProjection(db, {
			sessionId: "session",
			messages: applyAdmittedRecallToMessages(firstMessages, retry.event!),
			contract,
		});
		expect(retryPublished.action).toBe("unchanged");
		expect(decoder.decode(readContextProjection(db, "session", "main")!.body)).toBe(firstBody);
		expect(searches).toBe(1);

		const laterMessages = [
			...withRecall,
			{ id: "a1", role: "assistant", content: "friday" },
			{ id: "u2", role: "user", content: "and the rollback?" },
		];
		const later = await admitAutomaticRecall({
			db,
			sessionId: "session",
			messages: laterMessages,
			userEntryAnchor: "u2",
			query: "and the rollback?",
			scope: { project: "project" },
			client,
		});
		expect(later.status).toBe("admitted");
		expect(later.event?.eventId).not.toBe(first.event?.eventId);
		const laterPublished = publishContextProjection(db, {
			sessionId: "session",
			messages: applyAdmittedRecallToMessages(laterMessages, later.event!),
			contract,
		});
		expect(laterPublished.action).toBe("append");
		expect(decoder.decode(readContextProjection(db, "session", "main")!.body).startsWith(firstBody)).toBe(true);
		expect(searches).toBe(2);
	});

	test("sibling branches do not share recall events", async () => {
		const db = createDb();
		const client = fakeClient(() =>
			Promise.resolve({ memories: [{ id: "m1", content: "secret", project: "project" }] }),
		);
		const main = await admitAutomaticRecall({
			db,
			sessionId: "session",
			branchId: "main",
			messages: [{ id: "u1", role: "user", content: "q" }],
			userEntryAnchor: "u1",
			query: "q",
			scope: { project: "project" },
			client,
		});
		expect(main.status).toBe("admitted");
		expect(listActiveBranchRecallEvents(db, "session", "other")).toEqual([]);
		expect(listActiveBranchRecallEvents(db, "session", "main")).toHaveLength(1);
	});

	test("privacy withdrawal cannot fall back to withdrawn LKG", async () => {
		const db = createDb();
		publishContextProjection(db, {
			sessionId: "session",
			messages: [{ id: "u1", role: "user", content: "secret" }],
			contract,
		});
		const withdrawn = withdrawProjectionPrivacy(db, {
			sessionId: "session",
			messages: [{ id: "u1", role: "user", content: "[redacted]" }],
			contract,
		});
		expect(withdrawn.action).toBe("withdrawn");
		expect(readContextProjection(db, "session", "main")).toBeUndefined();
	});

	test("backend-down search admits nothing and leaves the window messages intact", async () => {
		const db = createDb();
		const messages = [{ id: "u1", role: "user", content: "hello" }];
		const failed = await admitAutomaticRecall({
			db,
			sessionId: "session",
			messages,
			userEntryAnchor: "u1",
			query: "hello",
			scope: { project: "project" },
			client: fakeClient(() => Promise.reject(new Error("ECONNREFUSED"))),
		});
		expect(failed.status).toBe("failed");
		expect(listActiveBranchRecallEvents(db, "session", "main")).toEqual([]);
		expect(messages).toEqual([{ id: "u1", role: "user", content: "hello" }]);
	});

	test("TUI presentation does not reprint on retry", async () => {
		const db = createDb();
		const first = await admitAutomaticRecall({
			db,
			sessionId: "session",
			messages: [{ id: "u1", role: "user", content: "q" }],
			userEntryAnchor: "u1",
			query: "q",
			scope: { project: "project" },
			client: fakeClient(() => Promise.resolve({ memories: [{ id: "m1", content: "note", project: "project" }] })),
		});
		let widgets = 0;
		const ui = {
			setWidget: () => {
				widgets += 1;
			},
		};
		expect(
			presentAdmittedRecall({
				db,
				ui,
				hasUI: true,
				event: first.event!,
				presenterToken: "session",
			}).presented,
		).toBe(true);
		expect(
			presentAdmittedRecall({
				db,
				ui,
				hasUI: true,
				event: first.event!,
				presenterToken: "session",
			}).presented,
		).toBe(false);
		expect(widgets).toBe(1);
	});

	test("unreachable AgentMemory HTTP endpoint fails closed", async () => {
		const client = new AgentMemoryClient({ url: "http://127.0.0.1:1" }, { defaults: { health: 200 } });
		await expect(client.health({ timeoutMs: 200 })).rejects.toMatchObject({ kind: "network" });
	});
});
