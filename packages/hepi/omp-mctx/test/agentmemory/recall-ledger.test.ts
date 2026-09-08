import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	admitRecallEvent,
	claimRecallPresentation,
	completeRecallPresentation,
	deriveRecallEventId,
	declarePreUpgradeEpoch,
	ensureRecallLedgerSchema,
	gcUnreachableRecall,
	getRecallEvent,
	getRecallRetention,
	listActiveBranchRecallEvents,
	recordBranchLineage,
	recordProjectionEpoch,
	releaseRecallRecoveryReference,
	retainRecallRecoveryReference,
	type RecallEventInput,
} from "../../src/agentmemory/recall-ledger";
import { Database } from "../../src/core/shared/sqlite";

const databases: Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

function createDb(databasePath = ":memory:"): Database {
	const db = new Database(databasePath);
	databases.push(db);
	ensureRecallLedgerSchema(db);
	return db;
}

function closeDb(db: Database): void {
	db.close();
	databases.splice(databases.indexOf(db), 1);
}

function seedEpoch(
	db: Database,
	epochId: string,
	branchId: string,
	options: {
		parentEpochId?: string;
		reachableEpochs?: Array<{ epochId: string; maxEventSequence: number; lineageDepth: number }>;
		activate?: boolean;
		reason?: string;
	} = {},
): void {
	recordProjectionEpoch(db, {
		epochId,
		sessionId: "session",
		branchId,
		...(options.parentEpochId ? { parentEpochId: options.parentEpochId } : {}),
		reason: options.reason ?? "upgrade",
		rendererVersion: "ledger-test",
		contractDigest: "contract",
		snapshotDigest: `snapshot-${epochId}`,
		...(options.reachableEpochs ? { reachableEpochs: options.reachableEpochs } : {}),
		...(options.activate !== undefined ? { activate: options.activate } : {}),
	});
}

function eventInput(anchor: string, epochId = "epoch-main", branchId = "main"): RecallEventInput {
	return {
		sessionId: "session",
		branchId,
		userEntryAnchor: anchor,
		epochId,
		body: new TextEncoder().encode("exact provider bytes"),
		origin: "direct_retrieval",
		promotionEligibility: "requires_independent_evidence",
		sources: [
			{
				sourceId: "remote-1",
				sourceKind: "memory",
				contentDigest: "source-digest",
				project: "project",
				scope: { project: "project" },
			},
		],
		dependencies: [{ dependencyId: "turn-1", dependencyKind: "anti_feedback" }],
	};
}

describe("immutable recall ledger", () => {
	test("reopen preserves exact bytes, stable identity, provenance, and pending receipt", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recall-ledger-"));
		temporaryDirectories.push(directory);
		const databasePath = path.join(directory, "context.db");
		const first = createDb(databasePath);
		seedEpoch(first, "epoch-main", "main");
		const admitted = admitRecallEvent(first, eventInput("anchor-1"));
		closeDb(first);

		const reopened = createDb(databasePath);
		const recovered = getRecallEvent(reopened, admitted.eventId);
		expect(recovered?.eventId).toBe(deriveRecallEventId(eventInput("anchor-1")));
		expect(new TextDecoder().decode(recovered?.body)).toBe("exact provider bytes");
		expect(recovered?.bodyDigest).toBe(admitted.bodyDigest);
		expect(recovered?.sources[0]?.sourceId).toBe("remote-1");
		expect(recovered?.presentationState).toBe("pending");
	});

	test("failed admission rolls back event, dependency, source, and receipt together", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const invalidScope = { bad: BigInt(1) } as unknown as Record<string, string | number | boolean | null>;
		const input = eventInput("anchor-fail");
		expect(() =>
			admitRecallEvent(db, { ...input, sources: [{ ...input.sources[0]!, scope: invalidScope }] }),
		).toThrow();
		expect(getRecallEvent(db, deriveRecallEventId(input))).toBeUndefined();
		expect(db.prepare("SELECT count(*) AS count FROM mctx_recall_sources").get()).toEqual({ count: 0 });
		expect(db.prepare("SELECT count(*) AS count FROM mctx_recall_presentation_receipts").get()).toEqual({ count: 0 });
	});

	test("anchored retry returns the original immutable snapshot without changing provenance or receipt", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const input = eventInput("anchor-1");
		const first = admitRecallEvent(db, input);
		expect(claimRecallPresentation(db, first.eventId, "presenter-1", 41)).toBe(true);
		expect(completeRecallPresentation(db, first.eventId, "presenter-1", 42)).toBe(true);
		const retry = admitRecallEvent(db, input);
		expect(retry).toEqual({ ...first, presentationState: "presented" });

		expect(() => admitRecallEvent(db, { ...input, body: new TextEncoder().encode("changed") })).toThrow(
			"body conflicts",
		);
		expect(() =>
			admitRecallEvent(db, { ...input, sources: [{ ...input.sources[0]!, sourceId: "remote-2" }] }),
		).toThrow("sources conflicts");
		expect(() =>
			admitRecallEvent(db, {
				...input,
				dependencies: [{ dependencyId: "turn-2", dependencyKind: "anti_feedback" }],
			}),
		).toThrow("dependencies conflicts");
		const persisted = getRecallEvent(db, first.eventId);
		expect(persisted?.sources).toEqual(first.sources);
		expect(persisted?.dependencies).toEqual(first.dependencies);
		expect(persisted?.presentationState).toBe("presented");
		expect(db.prepare("SELECT count(*) AS count FROM mctx_recall_events").get()).toEqual({ count: 1 });
	});

	test("anchored retry uses locale-independent provenance ordering", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const input = {
			...eventInput("locale-order"),
			sources: [
				{ ...eventInput("locale-order").sources[0]!, sourceId: "a" },
				{ ...eventInput("locale-order").sources[0]!, sourceId: "B" },
				{ ...eventInput("locale-order").sources[0]!, sourceId: "\uE000" },
				{ ...eventInput("locale-order").sources[0]!, sourceId: "\u{10000}" },
			],
			dependencies: [
				{ dependencyId: "a", dependencyKind: "source" },
				{ dependencyId: "B", dependencyKind: "source" },
				{ dependencyId: "\uE000", dependencyKind: "source" },
				{ dependencyId: "\u{10000}", dependencyKind: "source" },
			],
		};
		const first = admitRecallEvent(db, input);
		expect(admitRecallEvent(db, input)).toEqual(first);
	});

	test("new user anchors are distinct and caller event IDs cannot override stable identity", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const first = admitRecallEvent(db, eventInput("anchor-1"));
		const later = admitRecallEvent(db, eventInput("anchor-2"));
		expect(later.eventId).not.toBe(first.eventId);
		expect(() => admitRecallEvent(db, { ...eventInput("anchor-3"), eventId: first.eventId })).toThrow(
			"stable anchored identity",
		);
		expect(db.prepare("SELECT count(*) AS count FROM mctx_recall_events").get()).toEqual({ count: 2 });
	});

	test("fork replay is capped at the parent anchor and excludes sibling events", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const inherited = admitRecallEvent(db, eventInput("main-before-fork"));
		recordBranchLineage(db, {
			sessionId: "session",
			branchId: "child",
			parentBranchId: "main",
			forkEpochId: "epoch-main",
			forkEventSequence: inherited.admissionSequence,
		});
		const postFork = admitRecallEvent(db, eventInput("main-after-fork"));
		seedEpoch(db, "epoch-child", "child", {
			reachableEpochs: [{ epochId: "epoch-main", maxEventSequence: inherited.admissionSequence, lineageDepth: 1 }],
		});
		const child = admitRecallEvent(db, eventInput("child-anchor", "epoch-child", "child"));

		recordBranchLineage(db, {
			sessionId: "session",
			branchId: "sibling",
			parentBranchId: "main",
			forkEpochId: "epoch-main",
			forkEventSequence: postFork.admissionSequence,
		});
		seedEpoch(db, "epoch-sibling", "sibling", {
			reachableEpochs: [{ epochId: "epoch-main", maxEventSequence: postFork.admissionSequence, lineageDepth: 1 }],
		});
		admitRecallEvent(db, eventInput("sibling-anchor", "epoch-sibling", "sibling"));

		expect(listActiveBranchRecallEvents(db, "session", "child").map(event => event.eventId)).toEqual([
			inherited.eventId,
			child.eventId,
		]);
	});

	test("rejects incomplete ancestor reachability and non-boundary fork cutoffs", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const inherited = admitRecallEvent(db, eventInput("main-before-fork"));
		recordBranchLineage(db, {
			sessionId: "session",
			branchId: "child",
			parentBranchId: "main",
			forkEpochId: "epoch-main",
			forkEventSequence: inherited.admissionSequence,
		});
		expect(() =>
			recordProjectionEpoch(db, {
				epochId: "epoch-child-missing-ancestor",
				sessionId: "session",
				branchId: "child",
				reason: "fork",
				rendererVersion: "ledger-test",
				contractDigest: "contract",
				snapshotDigest: "missing",
			}),
		).toThrow("every contiguous branch ancestor");
		expect(
			db.prepare("SELECT 1 FROM mctx_projection_epochs WHERE epoch_id = ?").get("epoch-child-missing-ancestor"),
		).toBeNull();
		expect(() =>
			recordBranchLineage(db, {
				sessionId: "session",
				branchId: "invalid-cutoff",
				parentBranchId: "main",
				forkEpochId: "epoch-main",
				forkEventSequence: inherited.admissionSequence + 1,
			}),
		).toThrow("fork epoch tail");
	});

	test("a new active epoch is self-only unless valid ancestor reachability is declared", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const old = admitRecallEvent(db, eventInput("old-anchor"));
		seedEpoch(db, "epoch-privacy", "main", { parentEpochId: "epoch-main", reason: "privacy_withdrawal" });
		expect(listActiveBranchRecallEvents(db, "session", "main")).toEqual([]);
		expect(() => admitRecallEvent(db, eventInput("stale-anchor", "epoch-main"))).toThrow("active projection epoch");
		expect(getRecallEvent(db, old.eventId)?.body).toEqual(old.body);
	});

	test("replay requires a current epoch instead of scanning historical event rows", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		admitRecallEvent(db, eventInput("anchor"));
		db.prepare("DELETE FROM mctx_projection_heads WHERE session_id = ? AND branch_id = ?").run("session", "main");
		expect(listActiveBranchRecallEvents(db, "session", "main")).toEqual([]);
	});

	test("epoch and branch identities fail closed on mismatches and immutable conflicts", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		expect(() => admitRecallEvent(db, { ...eventInput("wrong-session"), sessionId: "other" })).toThrow(
			"epoch session",
		);
		expect(() => admitRecallEvent(db, eventInput("wrong-branch", "epoch-main", "other"))).toThrow("epoch branch");
		expect(() =>
			recordProjectionEpoch(db, {
				epochId: "epoch-main",
				sessionId: "session",
				branchId: "main",
				reason: "different",
				rendererVersion: "ledger-test",
				contractDigest: "contract",
				snapshotDigest: "snapshot-epoch-main",
			}),
		).toThrow("epoch reason conflicts");
	});

	test("epoch retry is idempotent and cannot reactivate a historical epoch", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		seedEpoch(db, "epoch-current", "main", { parentEpochId: "epoch-main" });
		recordProjectionEpoch(db, {
			epochId: "epoch-main",
			sessionId: "session",
			branchId: "main",
			reason: "upgrade",
			rendererVersion: "ledger-test",
			contractDigest: "contract",
			snapshotDigest: "snapshot-epoch-main",
		});
		expect(
			db
				.prepare(
					"SELECT current_epoch_id FROM mctx_projection_heads WHERE session_id = 'session' AND branch_id = 'main'",
				)
				.get(),
		).toEqual({
			current_epoch_id: "epoch-current",
		});
		// Omitting reachability on an exact retry must not be treated as a mutation.
		recordProjectionEpoch(db, {
			epochId: "epoch-main",
			sessionId: "session",
			branchId: "main",
			reason: "upgrade",
			rendererVersion: "ledger-test",
			contractDigest: "contract",
			snapshotDigest: "snapshot-epoch-main",
			activate: false,
		});
		recordProjectionEpoch(db, {
			epochId: "epoch-main",
			sessionId: "session",
			branchId: "main",
			reason: "upgrade",
			rendererVersion: "ledger-test",
			contractDigest: "contract",
			snapshotDigest: "snapshot-epoch-main",
			activate: true,
		});
		expect(
			db
				.prepare(
					"SELECT current_epoch_id FROM mctx_projection_heads WHERE session_id = 'session' AND branch_id = 'main'",
				)
				.get(),
		).toEqual({ current_epoch_id: "epoch-current" });
	});

	test("epoch retries compare declared and persisted reachability even when the declaration is omitted", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		recordBranchLineage(db, {
			sessionId: "session",
			branchId: "child",
			parentBranchId: "main",
			forkEpochId: "epoch-main",
			forkEventSequence: 0,
		});
		seedEpoch(db, "epoch-child", "child", {
			reachableEpochs: [{ epochId: "epoch-main", maxEventSequence: 0, lineageDepth: 1 }],
		});
		expect(() =>
			recordProjectionEpoch(db, {
				epochId: "epoch-child",
				sessionId: "session",
				branchId: "child",
				reason: "upgrade",
				rendererVersion: "ledger-test",
				contractDigest: "contract",
				snapshotDigest: "snapshot-epoch-child",
			}),
		).toThrow("every contiguous branch ancestor");
		expect(db.prepare("SELECT current_epoch_id FROM mctx_projection_heads WHERE branch_id = 'child'").get()).toEqual({
			current_epoch_id: "epoch-child",
		});
	});

	test("rejects stale same-branch parents and root resets after bootstrap", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		seedEpoch(db, "epoch-current", "main", { parentEpochId: "epoch-main" });
		expect(() => seedEpoch(db, "epoch-reset", "main")).toThrow("parent is required");
		expect(() => seedEpoch(db, "epoch-stale", "main", { parentEpochId: "epoch-main" })).toThrow(
			"projection epoch parent conflicts",
		);
		expect(
			db
				.prepare(
					"SELECT current_epoch_id FROM mctx_projection_heads WHERE session_id = 'session' AND branch_id = 'main'",
				)
				.get(),
		).toEqual({ current_epoch_id: "epoch-current" });
	});

	test("cannot fork a branch from a withdrawn historical epoch", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		admitRecallEvent(db, eventInput("withdrawn"));
		seedEpoch(db, "epoch-withdrawn", "main", { parentEpochId: "epoch-main", reason: "privacy_withdrawal" });
		expect(() =>
			recordBranchLineage(db, {
				sessionId: "session",
				branchId: "child",
				parentBranchId: "main",
				forkEpochId: "epoch-main",
				forkEventSequence: 1,
			}),
		).toThrow("parent branch's current projection epoch");
	});

	test("rejects missing branch parents, lineage cycles, and unsafe creation timestamps", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		expect(() =>
			recordBranchLineage(db, {
				sessionId: "session",
				branchId: "orphan",
				parentBranchId: "missing",
				forkEpochId: "epoch-main",
				forkEventSequence: 0,
			}),
		).toThrow("Parent recall branch does not exist");
		recordBranchLineage(db, {
			sessionId: "session",
			branchId: "child",
			parentBranchId: "main",
			forkEpochId: "epoch-main",
			forkEventSequence: 0,
		});
		db.prepare(
			"UPDATE mctx_branch_lineage SET parent_branch_id = ?, fork_epoch_id = ?, fork_event_sequence = ? WHERE session_id = ? AND branch_id = ?",
		).run("child", "epoch-main", 0, "session", "main");
		expect(() =>
			recordProjectionEpoch(db, {
				sessionId: "session",
				branchId: "child",
				epochId: "cycle-epoch",
				reason: "fork",
				rendererVersion: "ledger-test",
				contractDigest: "contract",
				snapshotDigest: "cycle",
				reachableEpochs: [{ epochId: "epoch-main", maxEventSequence: 0, lineageDepth: 1 }],
			}),
		).toThrow("lineage contains a cycle");
		expect(() =>
			recordProjectionEpoch(db, {
				epochId: "unsafe-epoch",
				sessionId: "session",
				branchId: "main",
				reason: "upgrade",
				rendererVersion: "ledger-test",
				contractDigest: "contract",
				snapshotDigest: "unsafe",
				createdAt: Number.POSITIVE_INFINITY,
			}),
		).toThrow("Epoch creation time");
		expect(() => admitRecallEvent(db, { ...eventInput("unsafe-time"), createdAt: Number.NaN })).toThrow(
			"Recall event creation time",
		);
		expect(() =>
			recordBranchLineage(db, { sessionId: "session", branchId: "unsafe-branch", createdAt: Number.NaN }),
		).toThrow("Branch creation time");
		expect(() =>
			recordProjectionEpoch(db, {
				epochId: "negative-time",
				sessionId: "session",
				branchId: "main",
				reason: "upgrade",
				rendererVersion: "ledger-test",
				contractDigest: "contract",
				snapshotDigest: "negative",
				createdAt: -1,
			}),
		).toThrow("at least 0");
	});

	test("epoch recording fails closed when an intermediate lineage row disappears", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		recordBranchLineage(db, {
			sessionId: "session",
			branchId: "child",
			parentBranchId: "main",
			forkEpochId: "epoch-main",
			forkEventSequence: 0,
		});
		seedEpoch(db, "epoch-child", "child", {
			reachableEpochs: [{ epochId: "epoch-main", maxEventSequence: 0, lineageDepth: 1 }],
		});
		recordBranchLineage(db, {
			sessionId: "session",
			branchId: "grandchild",
			parentBranchId: "child",
			forkEpochId: "epoch-child",
			forkEventSequence: 0,
		});
		db.prepare("DELETE FROM mctx_branch_lineage WHERE session_id = 'session' AND branch_id = 'child'").run();
		expect(() =>
			recordProjectionEpoch(db, {
				epochId: "epoch-grandchild",
				sessionId: "session",
				branchId: "grandchild",
				reason: "fork",
				rendererVersion: "ledger-test",
				contractDigest: "contract",
				snapshotDigest: "grandchild",
				reachableEpochs: [
					{ epochId: "epoch-child", maxEventSequence: 0, lineageDepth: 1 },
					{ epochId: "epoch-main", maxEventSequence: 0, lineageDepth: 2 },
				],
			}),
		).toThrow("references missing branch: child");
		expect(db.prepare("SELECT 1 FROM mctx_projection_epochs WHERE epoch_id = 'epoch-grandchild'").get()).toBeNull();
	});

	test("epoch recording rejects persisted branch lineage beyond the traversal bound", () => {
		const db = createDb();
		for (let index = 0; index <= 256; index += 1) {
			seedEpoch(db, `deep-epoch-${index}`, `deep-branch-${index}`);
		}
		for (let index = 1; index <= 256; index += 1) {
			db.prepare(
				`UPDATE mctx_branch_lineage SET parent_branch_id = ?, fork_epoch_id = ?, fork_event_sequence = 0
				 WHERE session_id = 'session' AND branch_id = ?`,
			).run(`deep-branch-${index - 1}`, `deep-epoch-${index - 1}`, `deep-branch-${index}`);
		}
		expect(() =>
			recordProjectionEpoch(db, {
				epochId: "too-deep",
				sessionId: "session",
				branchId: "deep-branch-256",
				reason: "fork",
				rendererVersion: "ledger-test",
				contractDigest: "contract",
				snapshotDigest: "too-deep",
			}),
		).toThrow("exceeds the maximum depth");
		expect(db.prepare("SELECT 1 FROM mctx_projection_epochs WHERE epoch_id = 'too-deep'").get()).toBeNull();
	});

	test("length-framed event identity distinguishes delimiter-shaped anchors", () => {
		const first = deriveRecallEventId({ sessionId: "a", branchId: "b", userEntryAnchor: "c\u0000d", epochId: "e" });
		const second = deriveRecallEventId({ sessionId: "a", branchId: "b", userEntryAnchor: "c", epochId: "d\u0000e" });
		expect(first).not.toBe(second);
	});

	test("retention becomes eligible after live epoch, branch, dependency, and presentation references become unreachable", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const event = admitRecallEvent(db, eventInput("anchor"));
		expect(getRecallRetention(db, event.eventId)).toEqual({
			eventId: event.eventId,
			referencedByEpoch: true,
			referencedByBranch: true,
			referencedByDependency: false,
			referencedByPresentation: true,
			referencedByRecovery: false,
			eligible: false,
		});
		seedEpoch(db, "epoch-next", "main", { parentEpochId: "epoch-main" });
		expect(getRecallRetention(db, event.eventId)).toEqual({
			eventId: event.eventId,
			referencedByEpoch: false,
			referencedByBranch: false,
			referencedByDependency: false,
			referencedByPresentation: false,
			referencedByRecovery: false,
			eligible: true,
		});
		expect(getRecallEvent(db, event.eventId)).toBeDefined();
	});

	test("GC removes unreachable events but keeps the active-head event", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const orphan = admitRecallEvent(db, eventInput("orphan"));
		seedEpoch(db, "epoch-next", "main", { parentEpochId: "epoch-main" });
		const active = admitRecallEvent(db, eventInput("active", "epoch-next"));
		expect(gcUnreachableRecall(db)).toEqual({ deletedEvents: 1 });
		expect(getRecallEvent(db, orphan.eventId)).toBeUndefined();
		expect(getRecallEvent(db, active.eventId)).toBeDefined();
	});

	test("GC keeps events reachable through an active descendant branch", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const inherited = admitRecallEvent(db, eventInput("inherited"));
		recordBranchLineage(db, {
			sessionId: "session",
			branchId: "child",
			parentBranchId: "main",
			forkEpochId: "epoch-main",
			forkEventSequence: inherited.admissionSequence,
		});
		seedEpoch(db, "epoch-child", "child", {
			reachableEpochs: [{ epochId: "epoch-main", maxEventSequence: inherited.admissionSequence, lineageDepth: 1 }],
		});
		seedEpoch(db, "epoch-next", "main", { parentEpochId: "epoch-main" });
		expect(gcUnreachableRecall(db)).toEqual({ deletedEvents: 0 });
		expect(getRecallEvent(db, inherited.eventId)).toBeDefined();
	});

	test("an active descendant branch keeps anchored dependency and presentation references live", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const event = admitRecallEvent(db, eventInput("anchor"));
		recordBranchLineage(db, {
			sessionId: "session",
			branchId: "child",
			parentBranchId: "main",
			forkEpochId: "epoch-main",
			forkEventSequence: event.admissionSequence,
		});
		seedEpoch(db, "epoch-child", "child", {
			reachableEpochs: [{ epochId: "epoch-main", maxEventSequence: event.admissionSequence, lineageDepth: 1 }],
		});
		seedEpoch(db, "epoch-next", "main", { parentEpochId: "epoch-main" });
		expect(getRecallRetention(db, event.eventId)?.referencedByDependency).toBe(false);
		expect(getRecallRetention(db, event.eventId)?.referencedByPresentation).toBe(true);
		expect(getRecallRetention(db, event.eventId)?.eligible).toBe(false);
	});

	test("an active owner keeps an otherwise unreachable dependency target retained", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const target = admitRecallEvent(db, eventInput("target"));
		seedEpoch(db, "epoch-next", "main", { parentEpochId: "epoch-main" });
		const owner = admitRecallEvent(db, {
			...eventInput("owner", "epoch-next"),
			dependencies: [{ dependencyId: target.eventId, dependencyKind: "recall_causal_input" }],
		});

		expect(getRecallRetention(db, target.eventId)).toMatchObject({
			referencedByEpoch: false,
			referencedByBranch: false,
			referencedByDependency: true,
			eligible: false,
		});
		expect(getRecallRetention(db, owner.eventId)?.referencedByDependency).toBe(false);
	});

	test("recovery references retain an old epoch until explicitly released", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const event = admitRecallEvent(db, eventInput("recoverable"));
		seedEpoch(db, "epoch-next", "main", { parentEpochId: "epoch-main" });
		expect(getRecallRetention(db, event.eventId)?.eligible).toBe(true);

		retainRecallRecoveryReference(db, {
			referenceId: "lkg-1",
			sessionId: "session",
			epochId: "epoch-main",
			referenceKind: "lkg",
			createdAt: 10,
		});
		expect(getRecallRetention(db, event.eventId)).toMatchObject({ referencedByRecovery: true, eligible: false });
		expect(releaseRecallRecoveryReference(db, "lkg-1", 11)).toBe(true);
		expect(releaseRecallRecoveryReference(db, "lkg-1", 12)).toBe(false);
		expect(getRecallRetention(db, event.eventId)?.eligible).toBe(true);
	});

	test("rejects recovery references when an epoch lost its self reachability anchor", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		admitRecallEvent(db, eventInput("corrupt-recovery"));
		db.prepare("DELETE FROM mctx_projection_epoch_reachability WHERE epoch_id = ? AND reachable_epoch_id = ?").run(
			"epoch-main",
			"epoch-main",
		);
		expect(() =>
			retainRecallRecoveryReference(db, {
				referenceId: "corrupt-lkg",
				sessionId: "session",
				epochId: "epoch-main",
				referenceKind: "lkg",
			}),
		).toThrow("self anchor");
	});

	test("a child recovery reference retains inherited parent events within its fork boundary", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const inherited = admitRecallEvent(db, eventInput("inherited"));
		recordBranchLineage(db, {
			sessionId: "session",
			branchId: "child",
			parentBranchId: "main",
			forkEpochId: "epoch-main",
			forkEventSequence: inherited.admissionSequence,
		});
		seedEpoch(db, "epoch-child", "child", {
			reachableEpochs: [{ epochId: "epoch-main", maxEventSequence: inherited.admissionSequence, lineageDepth: 1 }],
		});
		seedEpoch(db, "epoch-next", "main", { parentEpochId: "epoch-main" });
		retainRecallRecoveryReference(db, {
			referenceId: "child-lkg",
			sessionId: "session",
			epochId: "epoch-child",
			referenceKind: "lkg",
			createdAt: 10,
		});
		expect(getRecallRetention(db, inherited.eventId)).toMatchObject({
			referencedByRecovery: true,
			eligible: false,
		});
	});

	test("presentation claim is compare-and-set and duplicate delivery preserves the first timestamp", () => {
		const db = createDb();
		seedEpoch(db, "epoch-main", "main");
		const event = admitRecallEvent(db, eventInput("anchor"));
		expect(claimRecallPresentation(db, event.eventId, "presenter-1", 41)).toBe(true);
		expect(claimRecallPresentation(db, event.eventId, "presenter-2", 42)).toBe(false);
		expect(completeRecallPresentation(db, event.eventId, "presenter-2", 98)).toBe(false);
		expect(completeRecallPresentation(db, event.eventId, "presenter-1", 99)).toBe(true);
		expect(completeRecallPresentation(db, event.eventId, "presenter-1", 100)).toBe(false);
		expect(
			db
				.prepare(
					"SELECT state, claim_token, claimed_at, presented_at FROM mctx_recall_presentation_receipts WHERE event_id = ? AND surface = 'tui'",
				)
				.get(event.eventId),
		).toEqual({
			state: "presented",
			claim_token: "presenter-1",
			claimed_at: 41,
			presented_at: 99,
		});
	});

	test("an expired presentation claim can be safely reclaimed after restart", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recall-claim-"));
		temporaryDirectories.push(directory);
		const databasePath = path.join(directory, "context.db");
		const first = createDb(databasePath);
		seedEpoch(first, "epoch-main", "main");
		const event = admitRecallEvent(first, eventInput("claim-recovery"));
		expect(claimRecallPresentation(first, event.eventId, "old-presenter", 100, "tui", 10)).toBe(true);
		closeDb(first);

		const reopened = createDb(databasePath);
		expect(claimRecallPresentation(reopened, event.eventId, "still-live", 109, "tui", 10)).toBe(false);
		expect(claimRecallPresentation(reopened, event.eventId, "new-presenter", 110, "tui", 10)).toBe(true);
		expect(completeRecallPresentation(reopened, event.eventId, "old-presenter", 111)).toBe(false);
		expect(completeRecallPresentation(reopened, event.eventId, "new-presenter", 112)).toBe(true);
	});

	test("a pre-upgrade epoch creates a head without fabricating recall events", () => {
		const db = createDb();
		const declared = declarePreUpgradeEpoch(db, {
			sessionId: "session",
			branchId: "main",
			rendererVersion: "ledger-test",
			contractDigest: "contract",
			snapshotDigest: "snapshot-upgrade",
			createdAt: 10,
		});
		expect(declared.created).toBe(true);
		expect(
			db
				.prepare("SELECT current_epoch_id FROM mctx_projection_heads WHERE session_id = ? AND branch_id = ?")
				.get("session", "main"),
		).toEqual({
			current_epoch_id: declared.epochId,
		});
		expect(listActiveBranchRecallEvents(db, "session", "main")).toEqual([]);
		expect(
			db
				.prepare(
					"SELECT (SELECT COUNT(*) FROM mctx_recall_events) AS events, (SELECT COUNT(*) FROM mctx_recall_sources) AS sources, (SELECT COUNT(*) FROM mctx_recall_dependencies) AS dependencies, (SELECT COUNT(*) FROM mctx_recall_presentation_receipts) AS receipts",
				)
				.get(),
		).toEqual({ events: 0, sources: 0, dependencies: 0, receipts: 0 });
	});
	test("pre-upgrade identity is stable by branch and honors a supplied bootstrap identity", () => {
		const first = createDb();
		const second = createDb();
		const firstEpoch = declarePreUpgradeEpoch(first, {
			sessionId: "session",
			branchId: "stable",
			rendererVersion: "renderer-one",
			contractDigest: "contract-one",
			snapshotDigest: "snapshot-one",
		});
		const secondEpoch = declarePreUpgradeEpoch(second, {
			sessionId: "session",
			branchId: "stable",
			rendererVersion: "renderer-two",
			contractDigest: "contract-two",
			snapshotDigest: "snapshot-two",
		});
		expect(secondEpoch.epochId).toBe(firstEpoch.epochId);
		expect(
			declarePreUpgradeEpoch(first, {
				sessionId: "session",
				branchId: "custom",
				epochId: "caller-selected-upgrade",
				rendererVersion: "ledger-test",
				contractDigest: "contract",
				snapshotDigest: "snapshot",
			}),
		).toEqual({ epochId: "caller-selected-upgrade", created: true });
	});

	test("retrying a pre-upgrade declaration is idempotent and fabricates nothing", () => {
		const db = createDb();
		const input = {
			sessionId: "session",
			branchId: "main",
			rendererVersion: "ledger-test",
			contractDigest: "contract",
			snapshotDigest: "snapshot-upgrade",
			createdAt: 10,
		};
		const first = declarePreUpgradeEpoch(db, input);
		const retry = declarePreUpgradeEpoch(db, input);
		expect(retry).toEqual({ epochId: first.epochId, created: false });
		expect(db.prepare("SELECT COUNT(*) AS count FROM mctx_projection_epochs").get()).toEqual({ count: 1 });
		expect(listActiveBranchRecallEvents(db, "session", "main")).toEqual([]);
	});

	test("a failed pre-upgrade declaration leaves no epoch or head", () => {
		const db = createDb();
		expect(() =>
			declarePreUpgradeEpoch(db, {
				sessionId: "session",
				branchId: "main",
				rendererVersion: "ledger-test",
				contractDigest: "contract",
				snapshotDigest: "snapshot",
				createdAt: Number.NaN,
			}),
		).toThrow("Epoch creation time");
		expect(db.prepare("SELECT count(*) AS count FROM mctx_projection_epochs").get()).toEqual({ count: 0 });
		expect(db.prepare("SELECT count(*) AS count FROM mctx_projection_heads").get()).toEqual({ count: 0 });
		expect(listActiveBranchRecallEvents(db, "session", "main")).toEqual([]);
	});

	test("a pre-upgrade declaration reuses an existing head and never invents events", () => {
		const db = createDb();
		seedEpoch(db, "existing", "main");
		const declared = declarePreUpgradeEpoch(db, {
			sessionId: "session",
			branchId: "main",
			epochId: "requested-but-ignored",
			rendererVersion: "ledger-test",
			contractDigest: "contract",
			snapshotDigest: "snapshot-upgrade",
		});
		expect(declared).toEqual({ epochId: "existing", created: false });
		expect(db.prepare("SELECT COUNT(*) AS count FROM mctx_projection_epochs").get()).toEqual({ count: 1 });
		expect(listActiveBranchRecallEvents(db, "session", "main")).toEqual([]);
	});

	test("real recall admission works after declaring a pre-upgrade epoch", () => {
		const db = createDb();
		const declared = declarePreUpgradeEpoch(db, {
			sessionId: "session",
			branchId: "main",
			rendererVersion: "ledger-test",
			contractDigest: "contract",
			snapshotDigest: "snapshot-upgrade",
		});
		const admitted = admitRecallEvent(db, eventInput("later", declared.epochId));
		expect(listActiveBranchRecallEvents(db, "session", "main")).toEqual([admitted]);
	});

	test("schema does not persist recall candidates", () => {
		const db = createDb();
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('mctx_recall_candidates', 'mctx_recall_candidate')",
				)
				.all(),
		).toEqual([]);
	});
});
