import { describe, expect, test, vi } from "vitest";
import { initializeDatabase } from "../../../../src/core/features/storage-db";
import { reviewUserMemories } from "../../../../src/core/features/user-memory/review-user-memories";
import { insertUserMemoryCandidates } from "../../../../src/core/features/user-memory/storage-user-memory";
import { Database } from "../../../../src/core/shared/sqlite";

function freshDb(): Database {
	const db = new Database(":memory:");
	initializeDatabase(db);
	initializeDatabase(db);
	return db;
}

describe("reviewUserMemories", () => {
	test("deletes its child session when the review run fails", async () => {
		const db = freshDb();
		insertUserMemoryCandidates(db, [{ content: "User prefers concise updates", sessionId: "s1" }]);
		const deleted: string[] = [];
		const client = {
			session: {
				create: vi.fn(async () => ({ id: "child-user-memories" })),
				prompt: vi.fn(async () => {
					throw new Error("model unavailable");
				}),
				delete: vi.fn(async ({ path }: { path: { id: string } }) => {
					deleted.push(path.id);
					return {};
				}),
			},
		} as never;

		await expect(
			reviewUserMemories({
				db,
				client,
				parentSessionId: undefined,
				sessionDirectory: "/repo/project",
				holderId: "holder",
				leaseKey: "review-user-memories",
				deadline: Date.now() + 60_000,
				promotionThreshold: 1,
			}),
		).rejects.toThrow("model unavailable");

		expect(deleted).toEqual(["child-user-memories"]);
		db.close();
	});
});
