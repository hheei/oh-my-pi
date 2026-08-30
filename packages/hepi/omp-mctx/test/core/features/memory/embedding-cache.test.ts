import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	getProjectEmbeddings,
	resetEmbeddingCacheForTests,
	saveEmbedding,
	setEmbeddingCacheTtlForTests,
} from "../../../../src/core/features/memory/index";
import { insertMemory } from "../../../../src/core/features/memory/storage-memory";
import { initializeDatabase } from "../../../../src/core/features/storage-db";
import { Database } from "../../../../src/core/shared/sqlite";
import { closeQuietly } from "../../../../src/core/shared/sqlite-helpers";

let db: Database | null = null;

function createTestDb(): Database {
	const database = new Database(":memory:");
	initializeDatabase(database);
	return database;
}

function toNumbers(embedding: { embedding: Float32Array } | undefined): number[] {
	return embedding ? Array.from(embedding.embedding) : [];
}

afterEach(() => {
	resetEmbeddingCacheForTests();
	closeQuietly(db);
	db = null;
});

describe("embedding-cache", () => {
	it("reloads project embeddings after TTL expiry", async () => {
		db = createTestDb();
		setEmbeddingCacheTtlForTests(10);

		const memory = insertMemory(db, {
			projectPath: "/repo/project",
			category: "ARCHITECTURE_DECISIONS",
			content: "Cache embeddings for memory search.",
		});

		saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock:model");

		const initial = getProjectEmbeddings(db, "/repo/project", "mock:model");
		expect(toNumbers(initial.get(memory.id))).toEqual([1, 0]);

		saveEmbedding(db, memory.id, new Float32Array([0, 1]), "mock:model");

		const beforeExpiry = getProjectEmbeddings(db, "/repo/project", "mock:model");
		expect(toNumbers(beforeExpiry.get(memory.id))).toEqual([1, 0]);

		await sleep(20);

		const afterExpiry = getProjectEmbeddings(db, "/repo/project", "mock:model");
		expect(toNumbers(afterExpiry.get(memory.id))).toEqual([0, 1]);
	});
});
