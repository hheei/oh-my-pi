import { describe, expect, test } from "vitest";
import { initializeDatabase } from "../../../src/core/features/storage-db";
import {
	bumpEpochsForWorkspaceMembers,
	computeWorkspaceEpochFingerprint,
	resolveWorkspaceIdentityExpansion,
	resolveWorkspaceIdentitySet,
	resolveWorkspaceShareCategories,
} from "../../../src/core/features/workspaces";
import { Database } from "../../../src/core/shared/sqlite";
import { closeQuietly } from "../../../src/core/shared/sqlite-helpers";

function openDb(): Database {
	const db = new Database(":memory:");
	initializeDatabase(db);
	initializeDatabase(db);
	return db;
}

describe("workspace identity helpers", () => {
	test("resolves current workspace members", () => {
		const db = openDb();
		try {
			db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:new-a', 'A', '/a', 1), (1, 'git:new-b', 'B', '/b', 1);
            `);

			const set = resolveWorkspaceIdentitySet(db, "git:new-b");
			expect(set.identities).toEqual(["git:new-a", "git:new-b"]);
			expect(set.namesByIdentity.get("git:new-a")).toBe("A");
			expect(resolveWorkspaceIdentityExpansion(db, set.identities).expandedIdentities).toEqual([
				"git:new-a",
				"git:new-b",
			]);
		} finally {
			closeQuietly(db);
		}
	});

	test("workspace fingerprint is stable over sorted identity/epoch pairs", () => {
		const db = openDb();
		try {
			db.prepare(
				"INSERT INTO project_state (project_path, projectMemoryEpoch, project_user_profile_version, updated_at) VALUES (?, ?, 0, 1)",
			).run("git:b", 2);
			db.prepare(
				"INSERT INTO project_state (project_path, projectMemoryEpoch, project_user_profile_version, updated_at) VALUES (?, ?, 0, 1)",
			).run("git:a", 1);

			expect(computeWorkspaceEpochFingerprint(db, ["git:b", "git:a"])).toHaveLength(64);
			expect(computeWorkspaceEpochFingerprint(db, ["git:b", "git:a"])).toBe(
				computeWorkspaceEpochFingerprint(db, ["git:a", "git:b"]),
			);
		} finally {
			closeQuietly(db);
		}
	});

	test("share categories resolve as sorted canonical values and fingerprint tracks the normalized set", () => {
		const db = openDb();
		try {
			db.exec(`
                INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
                VALUES (1, 'ws', '["NAMING","CONSTRAINTS","NAMING"]', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:a', 'A', '/a', 1), (1, 'git:b', 'B', '/b', 1);
            `);

			const initial = computeWorkspaceEpochFingerprint(db, ["git:b", "git:a"]);

			expect(resolveWorkspaceShareCategories(db, "git:a")).toEqual(["CONSTRAINTS", "NAMING"]);
			db.prepare("UPDATE workspaces SET share_categories = ? WHERE id = 1").run(
				'["CONSTRAINTS","NAMING"]',
			);
			expect(computeWorkspaceEpochFingerprint(db, ["git:a", "git:b"])).toBe(initial);

			db.prepare("UPDATE workspaces SET share_categories = ? WHERE id = 1").run("[]");
			expect(computeWorkspaceEpochFingerprint(db, ["git:a", "git:b"])).not.toBe(initial);
			expect(resolveWorkspaceShareCategories(db, "git:a")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	test("share categories default legacy NULL and fail closed for malformed rows", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
                CREATE TABLE workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    share_categories TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE workspace_members (
                    workspace_id INTEGER NOT NULL,
                    project_path TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    display_path TEXT NOT NULL,
                    added_at INTEGER NOT NULL,
                    PRIMARY KEY (workspace_id, project_path)
                );
                INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
                VALUES (1, 'legacy-null', NULL, 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:a', 'A', '/a', 1), (1, 'git:b', 'B', '/b', 1);
            `);

			expect(resolveWorkspaceShareCategories(db, "git:a")).toEqual(["CONSTRAINTS"]);

			db.prepare("UPDATE workspaces SET share_categories = ? WHERE id = 1").run("not-json");
			expect(resolveWorkspaceShareCategories(db, "git:a")).toEqual([]);

			db.prepare("UPDATE workspaces SET share_categories = ? WHERE id = 1").run(
				'["CONSTRAINTS","NOT_A_CATEGORY"]',
			);
			expect(resolveWorkspaceShareCategories(db, "git:a")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	test("epoch fan-out bumps every member of the target workspace", () => {
		const db = openDb();
		try {
			db.exec(`
                INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'ws', 1, 1);
                INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
                VALUES (1, 'git:a', 'A', '/a', 1), (1, 'git:b', 'B', '/b', 1);
            `);

			bumpEpochsForWorkspaceMembers(db, "git:a", 10);

			expect(
				db
					.prepare("SELECT projectMemoryEpoch FROM project_state WHERE project_path = 'git:a'")
					.get(),
			).toEqual({ projectMemoryEpoch: 1 });
			expect(
				db
					.prepare("SELECT projectMemoryEpoch FROM project_state WHERE project_path = 'git:b'")
					.get(),
			).toEqual({ projectMemoryEpoch: 1 });
		} finally {
			closeQuietly(db);
		}
	});
});
