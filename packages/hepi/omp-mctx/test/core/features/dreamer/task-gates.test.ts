import { afterEach, describe, expect, test } from "vitest";
import { evaluateTaskGate } from "../../../../src/core/features/dreamer/task-gates";
import { insertMemory } from "../../../../src/core/features/memory";
import { initializeDatabase } from "../../../../src/core/features/storage-db";
import { Database } from "../../../../src/core/shared/sqlite";
import { closeQuietly } from "../../../../src/core/shared/sqlite-helpers";

let db: Database | null = null;

afterEach(() => {
	if (db) closeQuietly(db);
	db = null;
});

function freshDb(): Database {
	const database = new Database(":memory:");
	initializeDatabase(database);
	initializeDatabase(database);
	return database;
}

describe("evaluateTaskGate", () => {
	test("classify-memories runs when active memories exist", () => {
		db = freshDb();
		const projectIdentity = "/repo/project";
		expect(
			evaluateTaskGate("classify-memories", {
				db,
				projectIdentity,
				lastRunAt: null,
				promotionThreshold: 3,
			}),
		).toBe(false);

		insertMemory(db, {
			projectPath: projectIdentity,
			category: "PROJECT_RULES",
			content: "Use Bun for package scripts in this repo.",
		});

		expect(
			evaluateTaskGate("classify-memories", {
				db,
				projectIdentity,
				lastRunAt: Date.now(),
				promotionThreshold: 3,
			}),
		).toBe(true);
	});

	test("retrospective gates on the CONTENT watermark, not lastRunAt", () => {
		db = freshDb();
		const projectIdentity = "/repo/project";
		db.prepare(
			"INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
		).run("s1", "opencode", projectIdentity, 200);

		// Never scanned → runs.
		expect(
			evaluateTaskGate("retrospective", {
				db,
				projectIdentity,
				lastRunAt: null,
				retrospectiveWatermarkMs: null,
				promotionThreshold: 3,
			}),
		).toBe(true);
		// Session newer than watermark → runs (even if lastRunAt is newer — the
		// session was updated mid-run, so its content hasn't been scanned).
		expect(
			evaluateTaskGate("retrospective", {
				db,
				projectIdentity,
				lastRunAt: 9999,
				retrospectiveWatermarkMs: 100,
				promotionThreshold: 3,
			}),
		).toBe(true);
		// Watermark at/after the session update → nothing new → skip.
		expect(
			evaluateTaskGate("retrospective", {
				db,
				projectIdentity,
				lastRunAt: null,
				retrospectiveWatermarkMs: 300,
				promotionThreshold: 3,
			}),
		).toBe(false);
	});
});
