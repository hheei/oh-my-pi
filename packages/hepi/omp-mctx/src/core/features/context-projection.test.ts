import { afterEach, describe, expect, test } from "bun:test";
import {
	appendContextProjection,
	bootstrapContextProjection,
	deriveContextContractDigest,
	deriveContextProjectionId,
	ensureContextProjectionSchema,
	listContextProjectionTransitions,
	readContextProjection,
	readLastKnownGoodContextProjection,
	transitionContextProjection,
} from "./context-projection";
import { ensureRecallLedgerSchema, recordProjectionEpoch } from "../../agentmemory/recall-ledger";
import { Database } from "../shared/sqlite";

const databases: Database[] = [];

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function createDb(): Database {
	const db = new Database(":memory:");
	databases.push(db);
	ensureRecallLedgerSchema(db);
	ensureContextProjectionSchema(db);
	return db;
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function epoch(db: Database, epochId: string, parentEpochId?: string, reason = "initial"): void {
	recordProjectionEpoch(db, {
		epochId,
		sessionId: "session",
		branchId: "main",
		...(parentEpochId ? { parentEpochId } : {}),
		reason,
		rendererVersion: "projection-test",
		contractDigest: "contract",
		snapshotDigest: `snapshot-${epochId}`,
	});
}

const identity = {
	sessionId: "session",
	branchId: "main",
	epochId: "epoch-1",
	rendererVersion: "projection-test",
	contractDigest: "contract",
};

describe("Context Projection epochs", () => {
	test("publishes and reopens the exact baseline bytes", () => {
		const db = createDb();
		epoch(db, "epoch-1");
		const first = bootstrapContextProjection(db, { ...identity, baseline: bytes("system|user") });
		const reopened = readContextProjection(db, "session", "main");

		expect(reopened).toMatchObject({
			projectionId: deriveContextProjectionId(identity),
			epochId: "epoch-1",
			bodyDigest: first.bodyDigest,
			appendCount: 0,
			state: "active",
		});
		expect(new TextDecoder().decode(reopened?.body)).toBe("system|user");
	});

	test("repeated bootstrap is deterministic and conflicting bytes fail closed", () => {
		const db = createDb();
		epoch(db, "epoch-1");
		const first = bootstrapContextProjection(db, { ...identity, baseline: bytes("stable") });
		const retry = bootstrapContextProjection(db, { ...identity, baseline: bytes("stable") });
		expect(retry).toEqual(first);
		expect(() => bootstrapContextProjection(db, { ...identity, baseline: bytes("changed") })).toThrow(
			"baseline conflicts",
		);
	});

	test("append preserves the complete prior prefix and anchored retries are idempotent", () => {
		const db = createDb();
		epoch(db, "epoch-1");
		const initial = bootstrapContextProjection(db, { ...identity, baseline: bytes("prefix|") });
		const appended = appendContextProjection(db, {
			sessionId: "session",
			branchId: "main",
			epochId: "epoch-1",
			eventId: "user-1",
			body: bytes("user|assistant"),
		});
		const retry = appendContextProjection(db, {
			sessionId: "session",
			branchId: "main",
			epochId: "epoch-1",
			eventId: "user-1",
			body: bytes("user|assistant"),
		});

		expect(new TextDecoder().decode(appended.body)).toBe("prefix|user|assistant");
		expect(new TextDecoder().decode(appended.body.slice(0, initial.body.length))).toBe("prefix|");
		expect(retry).toEqual(appended);
		expect(() =>
			appendContextProjection(db, {
				sessionId: "session",
				branchId: "main",
				epochId: "epoch-1",
				eventId: "user-1",
				body: bytes("different"),
			}),
		).toThrow("conflicts");
	});

	test("failed ordinary publication leaves the last-known-good projection intact", () => {
		const db = createDb();
		epoch(db, "epoch-1");
		bootstrapContextProjection(db, { ...identity, baseline: bytes("known-good") });
		epoch(db, "epoch-2", "epoch-1", "compaction");
		expect(() =>
			transitionContextProjection(db, {
				...identity,
				epochId: "epoch-2",
				fromEpochId: "wrong-epoch",
				baseline: bytes("candidate"),
				reason: "compaction",
			}),
		).toThrow("source epoch is not current");
		expect(new TextDecoder().decode(readLastKnownGoodContextProjection(db, "session", "main")?.body)).toBe(
			"known-good",
		);
	});

	test("records non-append transitions and does not fall back after privacy withdrawal", () => {
		const db = createDb();
		epoch(db, "epoch-1");
		bootstrapContextProjection(db, { ...identity, baseline: bytes("before") });
		epoch(db, "epoch-2", "epoch-1", "compaction");
		const compacted = transitionContextProjection(db, {
			...identity,
			epochId: "epoch-2",
			fromEpochId: "epoch-1",
			baseline: bytes("after-compaction"),
			reason: "compaction",
			earliestChangedRegion: "history",
		});
		expect(
			transitionContextProjection(db, {
				...identity,
				epochId: "epoch-2",
				fromEpochId: "epoch-1",
				baseline: bytes("after-compaction"),
				reason: "compaction",
				earliestChangedRegion: "history",
			}),
		).toEqual(compacted);
		expect(new TextDecoder().decode(compacted.body)).toBe("after-compaction");
		epoch(db, "epoch-3", "epoch-2", "privacy_withdrawal");
		const withdrawn = transitionContextProjection(db, {
			...identity,
			epochId: "epoch-3",
			fromEpochId: "epoch-2",
			baseline: bytes("redacted"),
			reason: "privacy_withdrawal",
			withdrawsRecovery: true,
		});
		expect(withdrawn.state).toBe("withdrawn");
		expect(readContextProjection(db, "session", "main")).toBeUndefined();
		expect(listContextProjectionTransitions(db, "session", "main")).toEqual([
			expect.objectContaining({ reason: "compaction", earliestChangedRegion: "history" }),
			expect.objectContaining({ reason: "privacy_withdrawal", fromEpochId: "epoch-2", toEpochId: "epoch-3" }),
		]);
	});

	test("contract identity changes are explicit and stable", () => {
		const first = deriveContextContractDigest({
			rendererVersion: "r1",
			modelDigest: "model",
			systemDigest: "system",
			toolsDigest: "tools",
		});
		const same = deriveContextContractDigest({
			rendererVersion: "r1",
			modelDigest: "model",
			systemDigest: "system",
			toolsDigest: "tools",
		});
		const changed = deriveContextContractDigest({
			rendererVersion: "r2",
			modelDigest: "model",
			systemDigest: "system",
			toolsDigest: "tools",
		});
		expect(first).toBe(same);
		expect(changed).not.toBe(first);
	});
});
