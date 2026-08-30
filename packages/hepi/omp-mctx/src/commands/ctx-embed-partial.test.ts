import { afterEach, describe, expect, test } from "bun:test";
import type { EmbeddingConfig } from "#core/config/schema/magic-context";
import { appendCompartments } from "#core/features/compartment-storage";
import type { EmbeddingFailure } from "#core/features/memory/embedding-failure";
import type { EmbeddingProvider, EmbeddingPurpose } from "#core/features/memory/embedding-provider";
import {
	_resetProjectEmbeddingRegistryForTests,
	_setTestProviderFactoryForProject,
	registerProjectEmbedding,
} from "#core/features/project-embedding-registry";
import { setHarness } from "#core/shared/harness";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { initializeDatabase } from "#core/features/storage-db";
import { runEmbedDrain } from "./ctx-embed.ts";

function createTestDb(): Database {
	setHarness("pi");
	const db = new Database(":memory:");
	initializeDatabase(db, { memoryEnabled: true });
	return db;
}

class MixedBatchProvider implements EmbeddingProvider {
	readonly modelId = "fake-embedding-model";
	private lastFailure: EmbeddingFailure | null = null;

	async initialize(): Promise<boolean> {
		return true;
	}

	async embed(text: string, signal?: AbortSignal): Promise<Float32Array | null> {
		return (await this.embedBatch([text], signal))[0] ?? null;
	}

	async embedBatch(
		texts: string[],
		_signal?: AbortSignal,
		_purpose?: EmbeddingPurpose,
	): Promise<(Float32Array | null)[]> {
		const results = texts.map((text, index) =>
			index === 0 ? new Float32Array([text.length, 1]) : null,
		);
		if (results.some((vector) => vector === null)) {
			this.lastFailure = {
				class: "invalid_envelope",
				reason:
					"response had keys [data, object] but data[].embedding was absent for some inputs",
				retryable: true,
			};
		} else {
			this.lastFailure = null;
		}
		return results;
	}

	getLastFailureReason(): EmbeddingFailure | null {
		return this.lastFailure;
	}

	async dispose(): Promise<void> {}

	isLoaded(): boolean {
		return true;
	}
}

class CompleteBatchProvider implements EmbeddingProvider {
	readonly modelId = "fake-embedding-model";

	async initialize(): Promise<boolean> {
		return true;
	}

	async embed(text: string): Promise<Float32Array> {
		return new Float32Array([text.length, 1]);
	}

	async embedBatch(texts: string[]): Promise<Float32Array[]> {
		return texts.map((text) => new Float32Array([text.length, 1]));
	}

	getLastFailureReason(): EmbeddingFailure | null {
		return null;
	}

	async dispose(): Promise<void> {}

	isLoaded(): boolean {
		return true;
	}
}

function localConfig(): EmbeddingConfig {
	return { provider: "local", model: "fake-embedding-model" };
}

function seedCompartments(db: Database, sessionId: string, count: number): void {
	for (let i = 0; i < count; i += 1) {
		const start = i * 2 + 1;
		const end = start + 1;
		appendCompartments(db, sessionId, [
			{
				sequence: i,
				startMessage: start,
				endMessage: end,
				startMessageId: `u${start}`,
				endMessageId: `a${end}`,
				title: `Embedding slice ${i}`,
				content: `Embedding content ${i}`,
				p1: `Embedding content ${i}`,
			},
		]);
		db.prepare(
			"INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
		).run(sessionId, start, `${sessionId}-u${start}`, "user", `Question ${i}?`);
		db.prepare(
			"INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
		).run(sessionId, end, `${sessionId}-a${end}`, "assistant", `Answer ${i}.`);
	}
}

describe("Pi /ctx-embed partial drain", () => {
	afterEach(() => {
		_resetProjectEmbeddingRegistryForTests();
		_setTestProviderFactoryForProject(null);
	});

	test("mixed batch persists complete items and surfaces classified remaining failure", async () => {
		_setTestProviderFactoryForProject(() => new MixedBatchProvider());
		const db = createTestDb();
		try {
			const project = "pi-embed-partial";
			const sessionId = "pi-embed-partial-session";
			registerProjectEmbedding(
				db,
				project,
				localConfig(),
				{ memoryEnabled: true, gitCommitEnabled: false },
				"/tmp/pi-embed-partial",
			);
			seedCompartments(db, sessionId, 2);
			const terminal = await runEmbedDrain(db, project, sessionId);
			expect(terminal.level).toBe("info");
			expect(terminal.text).toContain("Embedded 1 compartment");
			expect(terminal.text).toContain("data[].embedding was absent for some inputs");
			expect(terminal.text).toContain("Run /ctx-embed start again to retry them.");
			expect(terminal.text).not.toContain("the provider returned no result");
		} finally {
			closeQuietly(db);
		}
	});

	test("complete batch does not leave a classified failure on the drain summary", async () => {
		_setTestProviderFactoryForProject(() => new CompleteBatchProvider());
		const db = createTestDb();
		try {
			const project = "pi-embed-complete";
			const sessionId = "pi-embed-complete-session";
			registerProjectEmbedding(
				db,
				project,
				localConfig(),
				{ memoryEnabled: true, gitCommitEnabled: false },
				"/tmp/pi-embed-complete",
			);
			seedCompartments(db, sessionId, 2);
			const terminal = await runEmbedDrain(db, project, sessionId);
			expect(terminal).toEqual({
				text: "## /ctx-embed\n\nEmbedded 2 compartments of history for semantic search.",
				level: "success",
			});
			expect(terminal.text).not.toContain("could not be embedded");
			expect(terminal.text).not.toContain("invalid_envelope");
		} finally {
			closeQuietly(db);
		}
	});
});
