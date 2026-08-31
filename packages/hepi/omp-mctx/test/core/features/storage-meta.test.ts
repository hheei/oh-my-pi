import { describe, expect, it, vi } from "vitest";
import { toDatabase } from "../../../src/core/features/mock-database";
import { clearSession, updateSessionMeta } from "../../../src/core/features/storage-meta";

function createMockDb() {
	const get = vi.fn((..._args: unknown[]) => undefined);
	const prepare = vi.fn((_sql: string) => ({
		get,
		run: vi.fn((..._args: unknown[]) => {}),
	}));

	const transaction = vi.fn((callback: () => void) => {
		return () => callback();
	});

	return {
		get,
		prepare,
		transaction,
	};
}

describe("storage-meta", () => {
	describe("updateSessionMeta", () => {
		it("runs insert + update inside a transaction", () => {
			//#given
			const db = createMockDb();

			//#when
			updateSessionMeta(toDatabase(db), "session-1", { counter: 3, lastNudgeTokens: 20_000 });

			//#then
			expect(db.transaction).toHaveBeenCalledTimes(1);
			const sqls = db.prepare.mock.calls.map((call: [string]) => call[0]);
			expect(sqls.some((sql: string) => sql.includes("INSERT OR IGNORE INTO session_meta"))).toBe(
				true,
			);
			expect(sqls.some((sql: string) => sql.startsWith("UPDATE session_meta SET"))).toBe(true);
		});

		it("does not start a transaction when there are no updates", () => {
			//#given
			const db = createMockDb();

			//#when
			updateSessionMeta(toDatabase(db), "session-1", {});

			//#then
			expect(db.transaction).not.toHaveBeenCalled();
			expect(db.prepare).not.toHaveBeenCalled();
		});

		it("stores null values using the empty-string sentinel", () => {
			//#given
			const db = createMockDb();

			//#when
			updateSessionMeta(toDatabase(db), "session-1", { lastNudgeBand: null });

			//#then
			const updateSqlIndex = db.prepare.mock.calls.findIndex((call: [string]) =>
				call[0].startsWith("UPDATE session_meta SET"),
			);
			expect(updateSqlIndex).toBeGreaterThanOrEqual(0);

			const updateResult = db.prepare.mock.results[updateSqlIndex]?.value as
				| { run: ReturnType<typeof vi.fn> }
				| undefined;
			const updateRun = updateResult?.run;
			expect(updateRun).toHaveBeenCalledWith("", "session-1");
		});
	});

	describe("clearSession", () => {
		it("runs all delete statements in one transaction", () => {
			//#given
			const db = createMockDb();

			//#when
			clearSession(toDatabase(db), "session-1");

			//#then
			// 2 transactions: outer clearSession + nested clearIndexedMessages
			expect(db.transaction).toHaveBeenCalledTimes(2);
			expect(db.get.mock.calls.map(([tableName]) => tableName)).toEqual([
				"compartment_chunk_embeddings",
				"user_memory_candidates",
				"primer_candidates",
				"embedding_measurement_corpus",
			]);
			// The mock reports all optional tables as absent, so only their four
			// capability probes plus durable LKG cleanup extend the prior count.
			expect(db.prepare).toHaveBeenCalledTimes(29);
		});
	});
});
