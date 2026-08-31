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
	});

	test("keeps legacy durable-memory tables on explicit opt-in", () => {
		const db = new Database(join(mkdtempSync(join(tmpdir(), "omp-mctx-memory-schema-")), "context.db"));
		databases.push(db);
		initializeDatabase(db, { memoryEnabled: true });

		const memoryTable = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
			.get();
		expect(memoryTable).toBeDefined();
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
			db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compartment_chunk_embeddings'")
				.get(),
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

	test("upgrades an existing Window-only database on a later Memory-on boot", () => {
		const dbPath = join(mkdtempSync(join(tmpdir(), "omp-mctx-memory-upgrade-")), "context.db");
		const windowDb = new Database(dbPath);
		databases.push(windowDb);
		initializeDatabase(windowDb);
		expect(hasSqliteTable(windowDb, "compartment_chunk_embeddings")).toBe(false);

		initializeDatabase(windowDb, { memoryEnabled: true });
		expect(hasSqliteTable(windowDb, "compartment_chunk_embeddings")).toBe(true);
		closeQuietly(windowDb);

		const memoryDb = new Database(dbPath);
		databases.push(memoryDb);
		initializeDatabase(memoryDb, { memoryEnabled: true });
		expect(hasSqliteTable(memoryDb, "compartment_chunk_embeddings")).toBe(true);
		expect(memoryDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get()).toBeDefined();
	});

});
