import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { closeDatabase, openDatabase, openDatabaseAsync } from "../../../src/core/features/storage-db";
import { getChannel2NudgeClaim, setChannel2NudgeState } from "../../../src/core/features/storage-meta";
import { Database } from "../../../src/core/shared/sqlite";
import { closeQuietly, hasSqliteTable } from "../../../src/core/shared/sqlite-helpers";

describe("fresh Magic Context database", () => {
	let tmpRoot: string;
	let savedXdg: string | undefined;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(os.tmpdir(), "magic-context-storage-test-"));
		savedXdg = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = tmpRoot;
		closeDatabase();
	});

	afterEach(() => {
		closeDatabase();
		if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = savedXdg;
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	test("creates the latest Window-only schema", () => {
		const db = openDatabase();
		if (!db) throw new Error("expected fresh database");

		const tableNames = new Set(
			(
				db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
					name: string;
				}>
			).map(row => row.name),
		);
		expect(tableNames.has("tags")).toBe(true);
		expect(tableNames.has("memories")).toBe(false);
		expect(tableNames.has("compartments")).toBe(true);
		expect(tableNames.has("v22_identity_rekey_map")).toBe(false);
		const sessionMetaColumns = new Set(
			(db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>).map(row => row.name),
		);
		expect(sessionMetaColumns.has("last_todo_state")).toBe(false);
		expect(sessionMetaColumns.has("todo_anchor_message_id")).toBe(false);
	});

	test("requeues stale Channel-2 claims when reopening", () => {
		const db = openDatabase();
		if (!db) throw new Error("expected fresh database");
		setChannel2NudgeState(db, "session", "claimed");
		db.prepare("UPDATE session_meta SET channel2_nudge_claimed_at = ? WHERE session_id = ?").run(
			Date.now() - 120_001,
			"session",
		);
		closeDatabase();

		const reopened = openDatabase();
		if (!reopened) throw new Error("expected reopened database");
		expect(getChannel2NudgeClaim(reopened, "session")).toEqual({
			state: "pending",
			claimedAt: 0,
			claimToken: "",
		});
	});

	test("does not upgrade a cached Window-only handle when legacy memory is requested", () => {
		const windowDb = openDatabase({ memoryEnabled: false });
		expect(hasSqliteTable(windowDb, "embedding_identity_active")).toBe(false);

		const memoryDb = openDatabase({ memoryEnabled: true });
		expect(memoryDb).toBe(windowDb);
		expect(hasSqliteTable(memoryDb, "embedding_identity_active")).toBe(false);
	});

	test("does not upgrade a cached async Window-only handle when legacy memory is requested", async () => {
		const windowDb = await openDatabaseAsync({ memoryEnabled: false });
		expect(hasSqliteTable(windowDb, "embedding_identity_active")).toBe(false);

		const memoryDb = await openDatabaseAsync({ memoryEnabled: true });
		expect(memoryDb).toBe(windowDb);
		expect(hasSqliteTable(memoryDb, "embedding_identity_active")).toBe(false);
	});

	test("opens databases with the removed migration ledger without rewriting it", () => {
		const dbPath = join(tmpRoot, "legacy.db");
		const legacy = new Database(dbPath);
		legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
		closeQuietly(legacy);

		const reopened = openDatabase(dbPath);
		expect(
			reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get(),
		).toEqual({
			name: "schema_migrations",
		});
	});
});
