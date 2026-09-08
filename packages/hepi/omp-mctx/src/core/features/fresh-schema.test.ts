import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DURABLE_MEMORY_TABLES } from "./fresh-schema";
import { clearSession } from "./storage-meta-session";
import { closeDatabase, initializeDatabase } from "./storage-db";
import { recordSessionProjectIdentity } from "./session-project-storage";
import { Database } from "../shared/sqlite";
import { closeQuietly, hasSqliteTable } from "../shared/sqlite-helpers";
import { loadPersistedLkgSlot, saveLkgSlotToDb } from "../hooks/lkg-persist";

const RECALL_LEDGER_TABLES = [
	"mctx_projection_epochs",
	"mctx_projection_epoch_reachability",
	"mctx_recall_events",
	"mctx_recall_sources",
	"mctx_recall_dependencies",
	"mctx_recall_presentation_receipts",
	"mctx_recall_recovery_refs",
	"mctx_projection_heads",
	"mctx_branch_lineage",
] as const;

describe("Window-only fresh schema", () => {
	const databases: Database[] = [];

	afterEach(() => {
		closeDatabase();
		for (const db of databases.splice(0)) closeQuietly(db);
	});
	test("creates no legacy durable-memory, embedding, or mirror tables", () => {
		const db = new Database(join(mkdtempSync(join(tmpdir(), "omp-mctx-window-schema-")), "context.db"));
		databases.push(db);
		initializeDatabase(db);

		const existing = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' OR type = 'view'")
			.all() as Array<{ name: string }>;
		for (const table of DURABLE_MEMORY_TABLES) {
			expect(existing.some(({ name }) => name === table || name.startsWith(`${table}_`))).toBe(false);
		}

		// Window search remains session-local and does not require Durable Memory.
		expect(existing.some(({ name }) => name === "message_history_fts")).toBe(true);
		expect(existing.some(({ name }) => name === "session_meta")).toBe(true);
		expect(existing.some(({ name }) => name === "lkg_slots")).toBe(true);
		for (const table of RECALL_LEDGER_TABLES) expect(hasSqliteTable(db, table)).toBe(true);
	});

	test("does not recreate legacy durable-memory tables from a retired option", () => {
		const db = new Database(join(mkdtempSync(join(tmpdir(), "omp-mctx-memory-schema-")), "context.db"));
		databases.push(db);
		initializeDatabase(db, { memoryEnabled: true });

		const memoryTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get();
		expect(memoryTable).toBeNull();
	});

	test("opens a legacy database without rewriting retained durable-memory rows", () => {
		const db = new Database(join(mkdtempSync(join(tmpdir(), "omp-mctx-legacy-open-")), "context.db"));
		databases.push(db);
		db.exec(
			"CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); " +
			"CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL); " +
			"INSERT INTO memories (id, content) VALUES (7, 'retain this legacy fact')",
		);

		initializeDatabase(db);

		expect(db.prepare("SELECT content FROM memories WHERE id = 7").get()).toEqual({
			content: "retain this legacy fact",
		});
		expect(
			db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_meta'").get(),
		).toBeDefined();
	});

	test("installs the recall ledger without rewriting legacy, outbox, or taint rows", () => {
		const db = new Database(join(mkdtempSync(join(tmpdir(), "omp-mctx-ledger-upgrade-")), "context.db"));
		databases.push(db);
		db.exec(
			"CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); " +
			"CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL); " +
			"CREATE TABLE agentmemory_outbox (" +
			"id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_hash TEXT NOT NULL UNIQUE, project TEXT NOT NULL, " +
			"agent_id TEXT, payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', " +
			"attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until INTEGER, " +
			"next_attempt_at INTEGER NOT NULL, delivered_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL); " +
			"CREATE TABLE agentmemory_turn_taint (" +
			"session_id TEXT NOT NULL, turn_id TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, " +
			"PRIMARY KEY (session_id, turn_id)); " +
			"INSERT INTO memories (id, content) VALUES (7, 'retain this legacy fact'); " +
			"INSERT INTO agentmemory_outbox (candidate_hash, project, payload_json, state, attempts, next_attempt_at, created_at) " +
			"VALUES ('candidate-sha', 'git:/repo', '{\"fact\":\"keep bytes\"}', 'pending', 0, 100, 99); " +
			"INSERT INTO agentmemory_turn_taint (session_id, turn_id, reason, created_at) " +
			"VALUES ('old-session', 'turn-1', 'legacy taint', 98)",
		);

		const before = {
			memory: db.prepare("SELECT id, content FROM memories").get(),
			outbox: db
				.prepare("SELECT candidate_hash, project, payload_json, state, attempts, next_attempt_at, created_at FROM agentmemory_outbox")
				.get(),
			taint: db.prepare("SELECT session_id, turn_id, reason, created_at FROM agentmemory_turn_taint").get(),
		};
		initializeDatabase(db);

		expect({
			memory: db.prepare("SELECT id, content FROM memories").get(),
			outbox: db
				.prepare("SELECT candidate_hash, project, payload_json, state, attempts, next_attempt_at, created_at FROM agentmemory_outbox")
				.get(),
			taint: db.prepare("SELECT session_id, turn_id, reason, created_at FROM agentmemory_turn_taint").get(),
		}).toEqual(before);
		for (const table of RECALL_LEDGER_TABLES) expect(hasSqliteTable(db, table)).toBe(true);
		expect(db.prepare("SELECT count(*) AS count FROM mctx_recall_events").get()).toEqual({ count: 0 });
		expect(db.prepare("SELECT count(*) AS count FROM mctx_projection_epochs").get()).toEqual({ count: 0 });
		expect(db.prepare("SELECT count(*) AS count FROM mctx_projection_heads").get()).toEqual({ count: 0 });
	});

	test("preserves Window outbox and taint rows across repeated ledger installation", () => {
		const db = new Database(join(mkdtempSync(join(tmpdir(), "omp-mctx-ledger-reopen-")), "context.db"));
		databases.push(db);
		initializeDatabase(db);
		db.prepare(
			"INSERT INTO agentmemory_outbox (candidate_hash, project, payload_json, state, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run("window-candidate", "git:/window", "{\"value\":1}", "pending", 0, 200, 199);
		db.prepare(
			"INSERT INTO agentmemory_turn_taint (session_id, turn_id, reason, created_at) VALUES (?, ?, ?, ?)",
		).run("window-session", "window-turn", "window taint", 198);

		const before = {
			outbox: db
				.prepare("SELECT candidate_hash, project, payload_json, state, attempts, next_attempt_at, created_at FROM agentmemory_outbox")
				.get(),
			taint: db.prepare("SELECT session_id, turn_id, reason, created_at FROM agentmemory_turn_taint").get(),
		};
		initializeDatabase(db);

		expect({
			outbox: db
				.prepare("SELECT candidate_hash, project, payload_json, state, attempts, next_attempt_at, created_at FROM agentmemory_outbox")
				.get(),
			taint: db.prepare("SELECT session_id, turn_id, reason, created_at FROM agentmemory_turn_taint").get(),
		}).toEqual(before);
		expect(db.prepare("SELECT count(*) AS count FROM mctx_recall_events").get()).toEqual({ count: 0 });
	});

	test("clears Window-only sessions without legacy tables", () => {
		const db = new Database(join(mkdtempSync(join(tmpdir(), "omp-mctx-window-cleanup-")), "context.db"));
		databases.push(db);
		initializeDatabase(db);
		recordSessionProjectIdentity(db, "window-session", "git:/tmp/window-project");
		expect(
			db.prepare("SELECT project_path FROM session_projects WHERE session_id = ?").get("window-session"),
		).toEqual({ project_path: "git:/tmp/window-project" });
		expect(
			db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compartment_chunk_embeddings'").get(),
		).toBeNull();
		expect(
			saveLkgSlotToDb(db, "window-session", {
				jsonPrefix: "{}",
				inputIdSeq: ["input-1"],
				inputContentDigests: ["digest-1"],
				lastInputMessageId: "message-1",
				modelKey: "model",
				providerKey: "provider",
				capturedAt: 1,
			}),
		).toBe(true);
		expect(loadPersistedLkgSlot(db, "window-session")).toBeDefined();
		clearSession(db, "window-session");
		expect(db.prepare("SELECT 1 FROM session_projects WHERE session_id = ?").get("window-session")).toBeNull();
		expect(loadPersistedLkgSlot(db, "window-session")).toBeUndefined();
	});

	test("does not upgrade a Window-only database on a later legacy-memory boot", () => {
		const dbPath = join(mkdtempSync(join(tmpdir(), "omp-mctx-memory-upgrade-")), "context.db");
		const windowDb = new Database(dbPath);
		databases.push(windowDb);
		initializeDatabase(windowDb);
		expect(hasSqliteTable(windowDb, "compartment_chunk_embeddings")).toBe(false);

		initializeDatabase(windowDb, { memoryEnabled: true });
		expect(hasSqliteTable(windowDb, "compartment_chunk_embeddings")).toBe(false);
		closeQuietly(windowDb);

		const memoryDb = new Database(dbPath);
		databases.push(memoryDb);
		initializeDatabase(memoryDb, { memoryEnabled: true });
		expect(hasSqliteTable(memoryDb, "compartment_chunk_embeddings")).toBe(false);
		expect(
			memoryDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get(),
		).toBeNull();
	});
});
