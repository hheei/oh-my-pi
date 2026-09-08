import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { admitRecallEvent, ensureRecallLedgerSchema, getRecallEvent } from "../../agentmemory/recall-ledger";
import {
	ensureContextProjectionSchema,
	listContextProjectionTransitions,
	readContextProjection,
	readLastKnownGoodContextProjection,
} from "./context-projection";
import {
	notePendingProjectionTransition,
	publishContextProjection,
	tryPublishContextProjection,
	withdrawProjectionPrivacy,
} from "./context-projection-coordinator";
import { Database } from "../shared/sqlite";

const databases: Database[] = [];
const decoder = new TextDecoder();
const databaseDirectories: string[] = [];

const contract = {
	modelDigest: "model-1",
	systemDigest: "system-1",
	toolsDigest: "tools-1",
};

function createDb(path = ":memory:"): Database {
	const db = new Database(path);
	databases.push(db);
	ensureRecallLedgerSchema(db);
	ensureContextProjectionSchema(db);
	return db;
}

function input(messages: readonly { id?: string; role?: string; content?: unknown }[]) {
	return { sessionId: "session", messages, contract };
}

function body(db: Database): string {
	return decoder.decode(readContextProjection(db, "session", "main")?.body);
}

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const directory of databaseDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Context Projection coordinator", () => {
	test("reuses identical JSONL bytes and appends a trailing message", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mctx-projection-coordinator-"));
		databaseDirectories.push(directory);
		let db = createDb(path.join(directory, "projection.sqlite"));
		const first = publishContextProjection(db, input([{ id: "u1", role: "user", content: "hello" }]));
		db.close();
		databases.splice(databases.indexOf(db), 1);
		db = createDb(path.join(directory, "projection.sqlite"));
		const reopened = readContextProjection(db, "session", "main");
		const repeated = publishContextProjection(db, input([{ id: "u1", role: "user", content: "hello" }]));
		const beforeAppend = readContextProjection(db, "session", "main");
		const appended = publishContextProjection(
			db,
			input([
				{ id: "u1", role: "user", content: "hello" },
				{ id: "a1", role: "assistant", content: "hi" },
			]),
		);
		if (!beforeAppend || !appended.record) throw new Error("expected append projection");
		expect(first.action).toBe("bootstrap");
		expect(reopened?.body).toEqual(first.record?.body);
		expect(repeated.action).toBe("unchanged");
		expect(repeated.record?.body).toEqual(first.record?.body);
		expect(appended.action).toBe("append");
		expect(decoder.decode(appended.record.body.slice(0, beforeAppend.body.byteLength))).toBe(
			decoder.decode(beforeAppend.body),
		);
		expect(body(db)).toBe(
			'{"content":"hello","id":"u1","role":"user"}\n{"content":"hi","id":"a1","role":"assistant"}',
		);
	});

	test("transitions for history edits, contract changes, and a pending refresh", () => {
		const db = createDb();
		publishContextProjection(db, input([{ id: "u1", role: "user", content: "before" }]));
		const changed = publishContextProjection(db, input([{ id: "u1", role: "user", content: "after" }]));
		const contractChanged = publishContextProjection(db, {
			...input([{ id: "u1", role: "user", content: "after" }]),
			contract: { ...contract, modelDigest: "model-2" },
		});
		notePendingProjectionTransition("session", "history_refresh", "history");
		const pendingNoop = publishContextProjection(db, {
			...input([{ id: "u1", role: "user", content: "after" }]),
			contract: { ...contract, modelDigest: "model-2" },
		});
		notePendingProjectionTransition("session", "history_refresh", "history");
		const pendingChange = publishContextProjection(db, {
			...input([{ id: "u1", role: "user", content: "refreshed" }]),
			contract: { ...contract, modelDigest: "model-2" },
		});
		const consumed = publishContextProjection(db, {
			...input([{ id: "u1", role: "user", content: "refreshed" }]),
			contract: { ...contract, modelDigest: "model-2" },
		});

		expect(changed.action).toBe("transition");
		expect(contractChanged.action).toBe("transition");
		expect(pendingNoop.action).toBe("unchanged");
		expect(pendingChange.action).toBe("transition");
		expect(consumed.action).toBe("unchanged");
		expect(listContextProjectionTransitions(db, "session", "main")).toEqual([
			expect.objectContaining({ reason: "history_refresh" }),
			expect.objectContaining({ reason: "renderer_contract" }),
			expect.objectContaining({ reason: "history_refresh", earliestChangedRegion: "history" }),
		]);
	});

	test("reuses the last-known-good projection after an immutable append conflict", () => {
		const db = createDb();
		publishContextProjection(db, input([{ id: "u1", role: "user", content: "first" }]));
		db.exec(`
			CREATE TRIGGER reject_u2_projection_append
			BEFORE INSERT ON mctx_context_projection_appends
			WHEN NEW.event_id = 'u2'
			BEGIN SELECT RAISE(ABORT, 'forced immutable append conflict'); END;
		`);
		const knownGood = readContextProjection(db, "session", "main");
		const result = tryPublishContextProjection(
			db,
			input([
				{ id: "u1", role: "user", content: "first" },
				{ id: "u2", role: "user", content: "second" },
			]),
		);

		expect(result.action).toBe("reused_lkg");
		expect(result.record?.body).toEqual(knownGood?.body);
	});

	test("withdrawal clears recovery and never returns withdrawn bytes", () => {
		const db = createDb();
		publishContextProjection(db, input([{ id: "u1", role: "user", content: "sensitive" }]));
		const withdrawn = publishContextProjection(db, {
			...input([{ id: "u1", role: "user", content: "redacted" }]),
			withdrawsRecovery: true,
		});
		const retried = tryPublishContextProjection(db, input([{ id: "u1", role: "user", content: "sensitive" }]));

		expect(withdrawn).toEqual({ action: "withdrawn", record: undefined });
		expect(readContextProjection(db, "session", "main")).toBeUndefined();
		expect(retried).toEqual({ action: "withdrawn", record: undefined });
	});

	test("privacy withdrawal clears LKG and GC removes recall from the withdrawn snapshot", () => {
		const db = createDb();
		publishContextProjection(db, input([{ id: "u1", role: "user", content: "sensitive" }]));
		const current = readContextProjection(db, "session", "main");
		if (!current) throw new Error("expected bootstrap projection");
		const recall = admitRecallEvent(db, {
			sessionId: "session",
			branchId: "main",
			epochId: current.epochId,
			userEntryAnchor: "u1",
			body: new TextEncoder().encode("withdrawn recall bytes"),
			origin: "direct_retrieval",
			promotionEligibility: "ineligible",
			sources: [],
			dependencies: [],
		});
		const withdrawn = withdrawProjectionPrivacy(db, input([{ id: "u1", role: "user", content: "redacted" }]));
		expect(withdrawn).toMatchObject({ action: "withdrawn", record: undefined, deletedEvents: 1 });
		expect(readLastKnownGoodContextProjection(db, "session", "main")).toBeUndefined();
		expect(getRecallEvent(db, recall.eventId)).toBeUndefined();
		expect(tryPublishContextProjection(db, input([{ id: "u1", role: "user", content: "sensitive" }]))).toEqual({
			action: "withdrawn",
			record: undefined,
		});
	});

	test("folds active recall after its anchor and puts missing anchors at the end", () => {
		const db = createDb();
		publishContextProjection(
			db,
			input([
				{ id: "u1", role: "user", content: "first" },
				{ id: "u2", role: "user", content: "second" },
			]),
		);
		const current = readContextProjection(db, "session", "main");
		if (!current) throw new Error("expected bootstrap projection");
		const anchored = admitRecallEvent(db, {
			sessionId: "session",
			branchId: "main",
			epochId: current.epochId,
			userEntryAnchor: "u1",
			body: new TextEncoder().encode("anchored recall"),
			origin: "direct_retrieval",
			promotionEligibility: "ineligible",
			sources: [],
			dependencies: [],
		});
		const trailing = admitRecallEvent(db, {
			sessionId: "session",
			branchId: "main",
			epochId: current.epochId,
			userEntryAnchor: "missing",
			body: new TextEncoder().encode("trailing recall"),
			origin: "direct_retrieval",
			promotionEligibility: "ineligible",
			sources: [],
			dependencies: [],
		});
		const published = publishContextProjection(
			db,
			input([
				{ id: "u1", role: "user", content: "first" },
				{ id: "u2", role: "user", content: "second" },
			]),
		);
		const lines = body(db)
			.split("\n")
			.map(line => JSON.parse(line) as { id: string; role: string; content: string });

		expect(published.action).toBe("transition");
		expect(lines.map(line => line.id)).toEqual(["u1", anchored.eventId, "u2", trailing.eventId]);
		expect(lines[1]).toMatchObject({ role: "recall", content: "anchored recall" });
		expect(lines[3]).toMatchObject({ role: "recall", content: "trailing recall" });
	});
});
