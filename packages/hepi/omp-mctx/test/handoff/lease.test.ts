import { describe, expect, test } from "vitest";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { initializeDatabase } from "../../src/core/features/storage-db";
import {
	acquireHandoffLease,
	getHandoffLease,
	releaseHandoffLease,
	renewHandoffLease,
} from "../../src/handoff/lease";

function createDb(): Database {
	const db = new Database(":memory:");
	initializeDatabase(db);
	initializeDatabase(db);
	return db;
}

describe("handoff lease", () => {
	test("acquires, renews, and fail-fasts a second holder", () => {
		const db = createDb();
		try {
			const first = acquireHandoffLease(db, "sess-1", "holder-a", "req-a", "preparing");
			expect(first?.holderId).toBe("holder-a");
			expect(getHandoffLease(db, "sess-1")?.requestId).toBe("req-a");
			expect(renewHandoffLease(db, "sess-1", "holder-a", "summarizing")).toBe(true);
			expect(renewHandoffLease(db, "sess-1", "holder-b", "summarizing")).toBe(false);
			expect(acquireHandoffLease(db, "sess-1", "holder-b", "req-b", "preparing")).toBeNull();

			releaseHandoffLease(db, "sess-1", "holder-b");
			expect(getHandoffLease(db, "sess-1")?.holderId).toBe("holder-a");
			releaseHandoffLease(db, "sess-1", "holder-a");
			expect(getHandoffLease(db, "sess-1")).toBeNull();
			expect(acquireHandoffLease(db, "sess-1", "holder-b", "req-b", "preparing")?.holderId).toBe(
				"holder-b",
			);
		} finally {
			closeQuietly(db);
		}
	});

	test("expired leases can be reacquired", () => {
		const db = createDb();
		try {
			const now = 1_000;
			expect(acquireHandoffLease(db, "sess-2", "old", "req-old", "preparing", now)).not.toBeNull();
			const next = acquireHandoffLease(
				db,
				"sess-2",
				"new",
				"req-new",
				"preparing",
				now + 6 * 60 * 1000,
			);
			expect(next?.holderId).toBe("new");
		} finally {
			closeQuietly(db);
		}
	});
});
