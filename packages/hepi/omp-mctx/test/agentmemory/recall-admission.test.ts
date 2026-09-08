import { afterEach, describe, expect, test } from "bun:test";
import {
	admitAutomaticRecall,
	applyAdmittedRecallToMessages,
	nextRecallGeneration,
} from "../../src/agentmemory/recall-admission";
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
import { ensureRecallLedgerSchema, listActiveBranchRecallEvents } from "../../src/agentmemory/recall-ledger";
import { Database } from "../../src/core/shared/sqlite";
import { SqliteTurnTaintStore } from "../../src/agentmemory/inject-save";

const databases: Database[] = [];

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function createDb(): Database {
	const db = new Database(":memory:");
	ensureRecallLedgerSchema(db);
	databases.push(db);
	return db;
}

type ClientControl = {
	search: (input: SearchInput, options?: AgentMemoryRequestOptions) => Promise<SearchResult>;
	searchLessons?: (input: LessonSearchInput, options?: AgentMemoryRequestOptions) => Promise<LessonSearchResult>;
};

function fakeClient(control: ClientControl): AgentMemoryClientPort {
	return {
		health: (): Promise<HealthResult> => Promise.resolve({ status: "ok" }),
		startSession: (_input: StartSessionInput): Promise<StartSessionResult> =>
			Promise.resolve({ sessionId: "session" }),
		observe: (_input: ObserveInput): Promise<ObserveResult> => Promise.resolve({}),
		search: control.search,
		searchLessons: control.searchLessons ?? (() => Promise.resolve({ lessons: [] })),
		getMemory: (_id: string): Promise<Memory | null> => Promise.resolve(null),
		listSessions: (): Promise<Session[]> => Promise.resolve([]),
		listMemories: (_input?: MemoryListInput): Promise<MemoryPage> => Promise.resolve({ memories: [] }),
		remember: (_input: RememberInput): Promise<RememberResult> =>
			Promise.resolve({ success: true, memory: { id: "remembered" } }),
		endSession: (_sessionId: string): Promise<void> => Promise.resolve(),
	};
}

function hit(id = "m1", content = "remember this", sessionId?: string): SearchResult {
	return { memories: [{ id, content, project: "project", agentId: "agent", ...(sessionId ? { sessionId } : {}) }] };
}

function input(db: Database, client: AgentMemoryClientPort, anchor = "u1") {
	return {
		db,
		sessionId: "session",
		messages: [{ id: "u1", role: "user", content: "what happened?" }],
		userEntryAnchor: anchor,
		query: "what happened?",
		scope: { project: "project", agentId: "agent" },
		client,
	};
}

describe("automatic recall admission", () => {
	test("searches once then reuses the anchored event with stable body bytes", async () => {
		const db = createDb();
		let searches = 0;
		const client = fakeClient({
			search: () => {
				searches += 1;
				return Promise.resolve(hit());
			},
		});
		const first = await admitAutomaticRecall(input(db, client));
		const second = await admitAutomaticRecall(input(db, client));
		expect(first.status).toBe("admitted");
		expect(second.status).toBe("reused");
		expect(searches).toBe(1);
		expect(second.event?.body).toEqual(first.event?.body);
	});

	test("admits independently for different user-entry anchors with identical query text", async () => {
		const db = createDb();
		const client = fakeClient({ search: () => Promise.resolve(hit()) });
		const first = await admitAutomaticRecall(input(db, client, "u1"));
		const second = await admitAutomaticRecall({
			...input(db, client, "u2"),
			messages: [{ id: "u2", role: "user", content: "what happened?" }],
		});
		expect(first.status).toBe("admitted");
		expect(second.status).toBe("admitted");
		expect(listActiveBranchRecallEvents(db, "session", "main")).toHaveLength(2);
	});

	test("drops stale in-flight generations without persisting an event", async () => {
		const db = createDb();
		const pending = Promise.withResolvers<SearchResult>();
		const client = fakeClient({ search: () => pending.promise });
		const first = admitAutomaticRecall(input(db, client));
		nextRecallGeneration("session");
		pending.resolve(hit());
		const result = await first;
		expect(result).toEqual({ status: "skipped", reason: "stale" });
		expect(listActiveBranchRecallEvents(db, "session", "main")).toHaveLength(0);
	});

	test("contains backend failures without creating recall events", async () => {
		const db = createDb();
		const client = fakeClient({ search: () => Promise.reject(new Error("backend down")) });
		const result = await admitAutomaticRecall(input(db, client));
		expect(result.status).toBe("failed");
		expect(listActiveBranchRecallEvents(db, "session", "main")).toHaveLength(0);
	});

	test("drops candidates already visible in the message window", async () => {
		const db = createDb();
		const client = fakeClient({ search: () => Promise.resolve(hit("m1", "already visible")) });
		const result = await admitAutomaticRecall({
			...input(db, client),
			messages: [{ id: "u1", role: "user", content: "I can see already visible here" }],
		});
		expect(result).toEqual({ status: "skipped", reason: "already-visible" });
		expect(listActiveBranchRecallEvents(db, "session", "main")).toHaveLength(0);
	});

	test("excludes hits from the active session", async () => {
		const db = createDb();
		const client = fakeClient({ search: () => Promise.resolve(hit("m1", "same session", "current")) });
		const result = await admitAutomaticRecall({
			...input(db, client),
			scope: { project: "project", agentId: "agent", activeSessionId: "current" },
		});
		expect(result).toEqual({ status: "skipped", reason: "empty-results" });
	});

	test("inserts admitted recall after its anchor without mutating or duplicating messages", async () => {
		const db = createDb();
		const client = fakeClient({ search: () => Promise.resolve(hit()) });
		const admitted = await admitAutomaticRecall(input(db, client));
		if (!admitted.event) throw new Error("expected admitted event");
		const messages = [
			{ id: "before", role: "assistant", content: "before" },
			{ id: "u1", role: "user", content: "question" },
			{ id: "after", role: "assistant", content: "after" },
		];
		const applied = applyAdmittedRecallToMessages(messages, admitted.event);
		expect(applied.map(message => message.id)).toEqual(["before", "u1", admitted.event.eventId, "after"]);
		expect(messages.map(message => message.id)).toEqual(["before", "u1", "after"]);
		expect(applyAdmittedRecallToMessages(applied, admitted.event)).toEqual(applied);
	});
	test("taints the admitted recall host entry rather than its user anchor", async () => {
		const db = createDb();
		const taint = new SqliteTurnTaintStore(db, "agentmemory");
		const result = await admitAutomaticRecall({
			...input(db, fakeClient({ search: () => Promise.resolve(hit()) })),
			taint,
		});
		if (!result.event) throw new Error("expected admitted recall event");
		expect(taint.isHostEntryTainted?.("u1")).toBe(false);
		expect(taint.isHostEntryTainted?.(result.event.eventId)).toBe(true);
	});
});
