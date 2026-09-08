import * as crypto from "node:crypto";
import type { Database } from "../core/shared/sqlite";
import { stableStringify } from "../core/shared/stable-json";

/** Local, immutable snapshots of recall admitted into a projection. */
export const RECALL_LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mctx_projection_epochs (
  epoch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_epoch_id TEXT,
  reason TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  earliest_changed_region TEXT,
  contract_digest TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(epoch_id, session_id, branch_id),
  FOREIGN KEY(parent_epoch_id) REFERENCES mctx_projection_epochs(epoch_id)
);
CREATE INDEX IF NOT EXISTS mctx_projection_epochs_branch_idx
  ON mctx_projection_epochs(session_id, branch_id, created_at);

CREATE TABLE IF NOT EXISTS mctx_branch_lineage (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_branch_id TEXT,
  fork_epoch_id TEXT,
  fork_event_sequence INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, branch_id),
  CHECK (
    (parent_branch_id IS NULL AND fork_epoch_id IS NULL AND fork_event_sequence IS NULL)
    OR (parent_branch_id IS NOT NULL AND fork_epoch_id IS NOT NULL AND fork_event_sequence >= 0)
  ),
  FOREIGN KEY(fork_epoch_id, session_id, parent_branch_id)
    REFERENCES mctx_projection_epochs(epoch_id, session_id, branch_id)
);

CREATE TABLE IF NOT EXISTS mctx_projection_heads (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  current_epoch_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, branch_id),
  FOREIGN KEY(current_epoch_id, session_id, branch_id)
    REFERENCES mctx_projection_epochs(epoch_id, session_id, branch_id)
);

CREATE TABLE IF NOT EXISTS mctx_projection_epoch_reachability (
  epoch_id TEXT NOT NULL,
  reachable_epoch_id TEXT NOT NULL,
  max_event_sequence INTEGER,
  lineage_depth INTEGER NOT NULL CHECK(lineage_depth >= 0),
  PRIMARY KEY(epoch_id, reachable_epoch_id),
  FOREIGN KEY(epoch_id) REFERENCES mctx_projection_epochs(epoch_id),
  FOREIGN KEY(reachable_epoch_id) REFERENCES mctx_projection_epochs(epoch_id)
);

CREATE TABLE IF NOT EXISTS mctx_recall_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  user_entry_anchor TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  admission_sequence INTEGER NOT NULL CHECK(admission_sequence > 0),
  body BLOB NOT NULL,
  body_digest TEXT NOT NULL,
  origin TEXT NOT NULL,
  promotion_eligibility TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, branch_id, user_entry_anchor, epoch_id),
  UNIQUE(epoch_id, admission_sequence),
  FOREIGN KEY(epoch_id, session_id, branch_id)
    REFERENCES mctx_projection_epochs(epoch_id, session_id, branch_id)
);
CREATE INDEX IF NOT EXISTS mctx_recall_events_branch_idx
  ON mctx_recall_events(session_id, branch_id, created_at);

CREATE INDEX IF NOT EXISTS mctx_recall_events_epoch_sequence_idx
  ON mctx_recall_events(epoch_id, admission_sequence);

CREATE TABLE IF NOT EXISTS mctx_recall_sources (
  event_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  project TEXT NOT NULL,
  agent_scope TEXT,
  remote_id TEXT,
  scope_json TEXT NOT NULL,
  PRIMARY KEY(event_id, source_id),
  FOREIGN KEY(event_id) REFERENCES mctx_recall_events(event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mctx_recall_dependencies (
  event_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  dependency_kind TEXT NOT NULL,
  PRIMARY KEY(event_id, dependency_id, dependency_kind),
  FOREIGN KEY(event_id) REFERENCES mctx_recall_events(event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mctx_recall_presentation_receipts (
  event_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'claimed', 'presented')),
  claim_token TEXT,
  claimed_at INTEGER,
  presented_at INTEGER,
  PRIMARY KEY(event_id, surface),
  FOREIGN KEY(event_id) REFERENCES mctx_recall_events(event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mctx_recall_recovery_refs (
  reference_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  event_id TEXT,
  reference_kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'released')),
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  CHECK ((state = 'active' AND released_at IS NULL) OR
         (state = 'released' AND released_at IS NOT NULL)),
  FOREIGN KEY(epoch_id) REFERENCES mctx_projection_epochs(epoch_id),
  FOREIGN KEY(event_id) REFERENCES mctx_recall_events(event_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mctx_recall_recovery_refs_epoch_idx
  ON mctx_recall_recovery_refs(epoch_id, state);
CREATE INDEX IF NOT EXISTS mctx_recall_recovery_refs_event_idx
  ON mctx_recall_recovery_refs(event_id, state);
`;

const MAX_BRANCH_LINEAGE_DEPTH = 256;

export type RecallEventOrigin = "direct_retrieval" | "retrieval_derived";
export type PromotionEligibility = "ineligible" | "requires_independent_evidence";
export type RecallPresentationState = "pending" | "claimed" | "presented";
export const RECALL_PRESENTATION_CLAIM_LEASE_MS = 120_000;

export type RecallSourceInput = {
	sourceId: string;
	sourceKind: string;
	contentDigest: string;
	project: string;
	agentScope?: string;
	remoteId?: string;
	scope: Record<string, string | number | boolean | null>;
};

export type RecallDependencyInput = {
	dependencyId: string;
	dependencyKind: string;
};

export type RecallReachableEpochInput = {
	epochId: string;
	maxEventSequence: number;
	lineageDepth: number;
};

export type RecallEpochInput = {
	epochId: string;
	sessionId: string;
	branchId: string;
	parentEpochId?: string;
	reason: string;
	rendererVersion: string;
	earliestChangedRegion?: string;
	contractDigest: string;
	snapshotDigest: string;
	reachableEpochs?: readonly RecallReachableEpochInput[];
	activate?: boolean;
	createdAt?: number;
};
export type PreUpgradeEpochInput = {
	sessionId: string;
	branchId: string;
	rendererVersion: string;
	contractDigest: string;
	snapshotDigest: string;
	epochId?: string;
	createdAt?: number;
};

/** Process-local retrieval material; candidates are deliberately never persisted. */
export type RecallCandidate = {
	body: Uint8Array;
	origin: RecallEventOrigin;
	promotionEligibility: PromotionEligibility;
	sources: readonly RecallSourceInput[];
	retrievedAt?: number;
};

export type RecallEventInput = {
	eventId?: string;
	sessionId: string;
	branchId: string;
	userEntryAnchor: string;
	epochId: string;
	body: Uint8Array;
	origin: RecallEventOrigin;
	promotionEligibility: PromotionEligibility;
	sources: readonly RecallSourceInput[];
	dependencies: readonly RecallDependencyInput[];
	createdAt?: number;
};

export type RecallEvent = Omit<RecallEventInput, "body" | "eventId" | "createdAt"> & {
	eventId: string;
	admissionSequence: number;
	body: Uint8Array;
	bodyDigest: string;
	presentationState: RecallPresentationState;
	createdAt: number;
};

export type RecallBranchInput = {
	sessionId: string;
	branchId: string;
	parentBranchId?: string;
	forkEpochId?: string;
	forkEventSequence?: number;
	createdAt?: number;
};

export type RecallRetention = {
	eventId: string;
	referencedByEpoch: boolean;
	referencedByBranch: boolean;
	referencedByDependency: boolean;
	referencedByPresentation: boolean;
	referencedByRecovery: boolean;
	eligible: boolean;
};

export type RecallRecoveryReferenceInput = {
	referenceId: string;
	sessionId: string;
	epochId: string;
	eventId?: string;
	referenceKind: string;
	createdAt?: number;
};

export type RecallIdentity = Pick<RecallEventInput, "sessionId" | "branchId" | "userEntryAnchor" | "epochId">;

type EpochRow = {
	epoch_id: unknown;
	session_id: unknown;
	branch_id: unknown;
	parent_epoch_id: unknown;
	reason: unknown;
	renderer_version: unknown;
	earliest_changed_region: unknown;
	contract_digest: unknown;
	snapshot_digest: unknown;
	created_at: unknown;
};

function digest(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Derive identity from stable anchors only; prompt text and array position are absent. */
export function deriveRecallEventId(identity: RecallIdentity): string {
	const parts = [
		ensureText(identity.sessionId, "sessionId"),
		ensureText(identity.branchId, "branchId"),
		ensureText(identity.userEntryAnchor, "userEntryAnchor"),
		ensureText(identity.epochId, "epochId"),
	];
	return `recall-${digestLengthFramed(parts)}`;
}

function derivePreUpgradeEpochId(sessionId: string, branchId: string): string {
	return `recall-upgrade-${digestLengthFramed([sessionId, branchId])}`;
}

function digestLengthFramed(parts: readonly string[]): string {
	const encoder = new TextEncoder();
	const framed = parts.map(part => {
		const bytes = encoder.encode(part);
		return new Uint8Array([...encoder.encode(`${bytes.length}:`), ...bytes]);
	});
	const length = framed.reduce((total, part) => total + part.length, 0);
	const encoded = new Uint8Array(length);
	let offset = 0;
	for (const part of framed) {
		encoded.set(part, offset);
		offset += part.length;
	}
	return digest(encoded);
}

function asBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return new Uint8Array(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	throw new Error("Recall ledger returned a non-binary body");
}

function ensureText(value: string, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be text`);
	if (!value.trim()) throw new Error(`${label} must not be empty`);
	return value;
}

function ensureSafeInteger(value: number, label: string, minimum?: number): number {
	if (!Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
		throw new Error(`${label} must be a ${minimum !== undefined ? `at least ${minimum} ` : ""}safe integer`);
	}
	return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Locale-independent ordering for persisted identity/provenance collections. */
function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function assertImmutable(label: string, actual: unknown, expected: unknown): void {
	if (actual !== expected) throw new Error(`Recall ${label} conflicts with the immutable ledger`);
}

function normalizeSources(sources: readonly RecallSourceInput[]): RecallSourceInput[] {
	const normalized = sources.map(source => ({
		sourceId: ensureText(source.sourceId, "sourceId"),
		sourceKind: ensureText(source.sourceKind, "sourceKind"),
		contentDigest: ensureText(source.contentDigest, "contentDigest"),
		project: ensureText(source.project, "project"),
		...(source.agentScope !== undefined ? { agentScope: ensureText(source.agentScope, "agentScope") } : {}),
		...(source.remoteId !== undefined ? { remoteId: ensureText(source.remoteId, "remoteId") } : {}),
		scope: source.scope,
	}));
	normalized.sort((left, right) => compareText(left.sourceId, right.sourceId));
	for (let index = 1; index < normalized.length; index += 1) {
		if (normalized[index - 1]?.sourceId === normalized[index]?.sourceId) {
			throw new Error(`Duplicate recall sourceId: ${normalized[index]?.sourceId}`);
		}
	}
	return normalized;
}

function normalizeDependencies(dependencies: readonly RecallDependencyInput[]): RecallDependencyInput[] {
	const normalized = dependencies.map(dependency => ({
		dependencyId: ensureText(dependency.dependencyId, "dependencyId"),
		dependencyKind: ensureText(dependency.dependencyKind, "dependencyKind"),
	}));
	normalized.sort(
		(left, right) =>
			compareText(left.dependencyId, right.dependencyId) || compareText(left.dependencyKind, right.dependencyKind),
	);
	for (let index = 1; index < normalized.length; index += 1) {
		const previous = normalized[index - 1];
		const current = normalized[index];
		if (previous?.dependencyId === current?.dependencyId && previous.dependencyKind === current.dependencyKind) {
			throw new Error(`Duplicate recall dependency: ${current?.dependencyId}/${current?.dependencyKind}`);
		}
	}
	return normalized;
}

export function ensureRecallLedgerSchema(db: Database): void {
	db.exec(RECALL_LEDGER_SCHEMA_SQL);
}

function readEpoch(db: Database, epochId: string): EpochRow | undefined {
	return db.prepare("SELECT * FROM mctx_projection_epochs WHERE epoch_id = ?").get(epochId) as EpochRow | undefined;
}

function assertEpochIdentity(row: EpochRow, sessionId: string, branchId: string): void {
	assertImmutable("epoch session", String(row.session_id), sessionId);
	assertImmutable("epoch branch", String(row.branch_id), branchId);
}

type BranchRow = {
	parent_branch_id: unknown;
	fork_epoch_id: unknown;
	fork_event_sequence: unknown;
};

function readBranch(db: Database, sessionId: string, branchId: string): BranchRow | undefined {
	return db
		.prepare(
			"SELECT parent_branch_id, fork_epoch_id, fork_event_sequence FROM mctx_branch_lineage WHERE session_id = ? AND branch_id = ?",
		)
		.get(sessionId, branchId) as BranchRow | undefined;
}

function collectBranchForks(db: Database, sessionId: string, branchId: string): Array<Record<string, unknown>> {
	const ancestors: Array<Record<string, unknown>> = [];
	const visited = new Set<string>([branchId]);
	let currentBranchId = branchId;
	for (let depth = 1; ; depth += 1) {
		if (depth > MAX_BRANCH_LINEAGE_DEPTH) throw new Error("Recall branch lineage exceeds the maximum depth");
		const branch = readBranch(db, sessionId, currentBranchId);
		if (!branch) {
			if (currentBranchId === branchId) return ancestors;
			throw new Error(`Recall branch lineage references missing branch: ${currentBranchId}`);
		}
		if (branch.parent_branch_id === null || branch.parent_branch_id === undefined) return ancestors;
		const parentBranchId = ensureText(String(branch.parent_branch_id), "parentBranchId");
		if (visited.has(parentBranchId)) throw new Error("Recall branch lineage contains a cycle");
		visited.add(parentBranchId);
		ancestors.push({
			sourceBranchId: parentBranchId,
			epochId: ensureText(String(branch.fork_epoch_id), "forkEpochId"),
			maxEventSequence: ensureSafeInteger(Number(branch.fork_event_sequence), "forkEventSequence", 0),
			lineageDepth: depth,
		});
		currentBranchId = parentBranchId;
	}
}

function assertReachableEpochs(db: Database, input: RecallEpochInput): RecallReachableEpochInput[] {
	const reachable = [...(input.reachableEpochs ?? [])].sort((left, right) => left.lineageDepth - right.lineageDepth);
	const anchors = collectBranchForks(db, input.sessionId, input.branchId);
	if (reachable.length !== anchors.length) {
		throw new Error("Projection epoch reachability must include every contiguous branch ancestor");
	}
	const seen = new Set<string>();
	for (const [index, entry] of reachable.entries()) {
		ensureText(entry.epochId, "reachable epochId");
		if (!Number.isSafeInteger(entry.maxEventSequence) || entry.maxEventSequence < 0) {
			throw new Error("maxEventSequence must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(entry.lineageDepth) || entry.lineageDepth < 1) {
			throw new Error("reachable ancestor lineageDepth must be a positive safe integer");
		}
		if (seen.has(entry.epochId)) throw new Error(`Duplicate reachable epoch: ${entry.epochId}`);
		seen.add(entry.epochId);
		const anchor = anchors[index];
		if (
			!anchor ||
			entry.lineageDepth !== index + 1 ||
			String(anchor.epochId) !== entry.epochId ||
			Number(anchor.maxEventSequence) !== entry.maxEventSequence
		) {
			throw new Error(`Reachable epoch ${entry.epochId} does not match the branch fork anchor`);
		}
		const epoch = readEpoch(db, entry.epochId);
		if (!epoch) throw new Error(`Reachable projection epoch does not exist: ${entry.epochId}`);
		assertImmutable("reachable epoch session", String(epoch.session_id), input.sessionId);
		assertImmutable("reachable epoch branch", String(epoch.branch_id), String(anchor.sourceBranchId));
	}
	return reachable;
}

function readPersistedReachability(db: Database, epochId: string): RecallReachableEpochInput[] {
	const rows = db
		.prepare(
			`SELECT reachable_epoch_id AS epochId, max_event_sequence AS maxEventSequence,
			 lineage_depth AS lineageDepth FROM mctx_projection_epoch_reachability
			 WHERE epoch_id = ? ORDER BY lineage_depth`,
		)
		.all(epochId) as Array<Record<string, unknown>>;
	if (
		rows.length === 0 ||
		rows[0]?.epochId !== epochId ||
		rows[0]?.maxEventSequence !== null ||
		rows[0]?.lineageDepth !== 0
	) {
		throw new Error("Projection epoch reachability is missing its self anchor");
	}
	return rows.slice(1).map(row => ({
		epochId: ensureText(String(row.epochId), "persisted reachable epochId"),
		maxEventSequence: ensureSafeInteger(Number(row.maxEventSequence), "persisted maxEventSequence", 0),
		lineageDepth: ensureSafeInteger(Number(row.lineageDepth), "persisted lineageDepth", 1),
	}));
}

/** Records a declared epoch and, by default, makes it the branch's current epoch. */
export function recordProjectionEpoch(db: Database, input: RecallEpochInput): void {
	ensureRecallLedgerSchema(db);
	const epochId = ensureText(input.epochId, "epochId");
	const sessionId = ensureText(input.sessionId, "sessionId");
	const branchId = ensureText(input.branchId, "branchId");
	const parentEpochId =
		input.parentEpochId !== undefined ? ensureText(input.parentEpochId, "parentEpochId") : undefined;
	const earliestChangedRegion =
		input.earliestChangedRegion !== undefined
			? ensureText(input.earliestChangedRegion, "earliestChangedRegion")
			: undefined;
	const now = ensureSafeInteger(input.createdAt ?? Date.now(), "Epoch creation time", 0);
	const write = () => {
		const existing = readEpoch(db, epochId);
		if (existing) {
			assertEpochIdentity(existing, sessionId, branchId);
			assertImmutable("epoch parent", existing.parent_epoch_id ?? null, parentEpochId ?? null);
			assertImmutable("epoch reason", String(existing.reason), ensureText(input.reason, "reason"));
			assertImmutable(
				"epoch renderer",
				String(existing.renderer_version),
				ensureText(input.rendererVersion, "rendererVersion"),
			);
			assertImmutable(
				"epoch changed region",
				existing.earliest_changed_region ?? null,
				earliestChangedRegion ?? null,
			);
			assertImmutable(
				"epoch contract",
				String(existing.contract_digest),
				ensureText(input.contractDigest, "contractDigest"),
			);
			assertImmutable(
				"epoch snapshot",
				String(existing.snapshot_digest),
				ensureText(input.snapshotDigest, "snapshotDigest"),
			);
			if (input.createdAt !== undefined)
				assertImmutable("epoch creation time", Number(existing.created_at), input.createdAt);
			const reachable = assertReachableEpochs(db, input);
			assertImmutable(
				"epoch reachability",
				stableStringify(readPersistedReachability(db, epochId)),
				stableStringify(reachable),
			);
			return;
		}
		const reachable = assertReachableEpochs(db, input);
		const currentHead = db
			.prepare("SELECT current_epoch_id FROM mctx_projection_heads WHERE session_id = ? AND branch_id = ?")
			.get(sessionId, branchId) as { current_epoch_id?: unknown } | undefined;
		if (currentHead) {
			if (!parentEpochId) {
				throw new Error("Projection epoch parent is required after branch bootstrap");
			}
			assertImmutable("projection epoch parent", String(currentHead.current_epoch_id), parentEpochId);
		} else if (parentEpochId) {
			throw new Error("Projection epoch parent cannot be set before branch bootstrap");
		}
		if (parentEpochId) {
			const parent = readEpoch(db, parentEpochId);
			if (!parent) throw new Error(`Parent projection epoch does not exist: ${parentEpochId}`);
			assertEpochIdentity(parent, sessionId, branchId);
			assertImmutable(
				"parent epoch reachability",
				stableStringify(readPersistedReachability(db, parentEpochId)),
				stableStringify(reachable),
			);
		}
		if (!parentEpochId) {
			db.prepare(
				`INSERT INTO mctx_branch_lineage
				 (session_id, branch_id, parent_branch_id, fork_epoch_id, fork_event_sequence, created_at)
				 VALUES (?, ?, NULL, NULL, NULL, ?)
				 ON CONFLICT(session_id, branch_id) DO NOTHING`,
			).run(sessionId, branchId, now);
		}
		{
			db.prepare(
				`INSERT INTO mctx_projection_epochs
				 (epoch_id, session_id, branch_id, parent_epoch_id, reason, renderer_version,
				  earliest_changed_region, contract_digest, snapshot_digest, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				epochId,
				sessionId,
				branchId,
				parentEpochId ?? null,
				ensureText(input.reason, "reason"),
				ensureText(input.rendererVersion, "rendererVersion"),
				earliestChangedRegion ?? null,
				ensureText(input.contractDigest, "contractDigest"),
				ensureText(input.snapshotDigest, "snapshotDigest"),
				now,
			);
			db.prepare(
				`INSERT INTO mctx_projection_epoch_reachability
				 (epoch_id, reachable_epoch_id, max_event_sequence, lineage_depth) VALUES (?, ?, NULL, 0)`,
			).run(epochId, epochId);
			for (const entry of reachable) {
				db.prepare(
					`INSERT INTO mctx_projection_epoch_reachability
					 (epoch_id, reachable_epoch_id, max_event_sequence, lineage_depth) VALUES (?, ?, ?, ?)`,
				).run(epochId, entry.epochId, entry.maxEventSequence, entry.lineageDepth);
			}
		}
		assertImmutable(
			"epoch reachability",
			stableStringify(readPersistedReachability(db, epochId)),
			stableStringify(reachable),
		);
		if (input.activate !== false) {
			db.prepare(
				`INSERT INTO mctx_projection_heads(session_id, branch_id, current_epoch_id, updated_at)
				 VALUES (?, ?, ?, ?) ON CONFLICT(session_id, branch_id) DO UPDATE SET
				 current_epoch_id = excluded.current_epoch_id, updated_at = excluded.updated_at`,
			).run(sessionId, branchId, epochId, now);
		}
	};
	db.transaction(write)();
}

/**
 * Declares the first ledger epoch for a session created before recall admission.
 * It records no reconstructed history and preserves an existing branch head.
 */
export function declarePreUpgradeEpoch(
	db: Database,
	input: PreUpgradeEpochInput,
): { epochId: string; created: boolean } {
	ensureRecallLedgerSchema(db);
	const sessionId = ensureText(input.sessionId, "sessionId");
	const branchId = ensureText(input.branchId, "branchId");
	const write = () => {
		const currentHead = db
			.prepare("SELECT current_epoch_id FROM mctx_projection_heads WHERE session_id = ? AND branch_id = ?")
			.get(sessionId, branchId) as { current_epoch_id: unknown } | undefined;
		if (currentHead) {
			return { epochId: ensureText(String(currentHead.current_epoch_id), "current epochId"), created: false };
		}

		const epochId =
			input.epochId === undefined
				? derivePreUpgradeEpochId(sessionId, branchId)
				: ensureText(input.epochId, "epochId");
		const existing = readEpoch(db, epochId);
		recordProjectionEpoch(db, {
			epochId,
			sessionId,
			branchId,
			reason: "upgrade",
			rendererVersion: input.rendererVersion,
			contractDigest: input.contractDigest,
			snapshotDigest: input.snapshotDigest,
			reachableEpochs: [],
			...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
		});
		if (existing) {
			db.prepare(
				`INSERT INTO mctx_projection_heads(session_id, branch_id, current_epoch_id, updated_at)
				 VALUES (?, ?, ?, ?) ON CONFLICT(session_id, branch_id) DO UPDATE SET
				 current_epoch_id = excluded.current_epoch_id, updated_at = excluded.updated_at`,
			).run(
				sessionId,
				branchId,
				epochId,
				ensureSafeInteger(input.createdAt ?? Date.now(), "Epoch creation time", 0),
			);
		}
		return { epochId, created: !existing };
	};
	return db.transaction(write)();
}

export function recordBranchLineage(db: Database, input: RecallBranchInput): void {
	ensureRecallLedgerSchema(db);
	const sessionId = ensureText(input.sessionId, "sessionId");
	const branchId = ensureText(input.branchId, "branchId");
	const parentBranchId =
		input.parentBranchId !== undefined ? ensureText(input.parentBranchId, "parentBranchId") : undefined;
	if (parentBranchId === branchId) throw new Error("A recall branch cannot be its own parent");
	if (parentBranchId && (!input.forkEpochId || input.forkEventSequence === undefined)) {
		throw new Error("Child recall branches require a fork epoch and event sequence");
	}
	if (!parentBranchId && (input.forkEpochId !== undefined || input.forkEventSequence !== undefined)) {
		throw new Error("Root recall branches cannot have fork anchors");
	}
	if (input.forkEventSequence !== undefined) ensureSafeInteger(input.forkEventSequence, "forkEventSequence", 0);
	const forkEpochId = input.forkEpochId !== undefined ? ensureText(input.forkEpochId, "forkEpochId") : undefined;
	const now = ensureSafeInteger(input.createdAt ?? Date.now(), "Branch creation time", 0);
	if (forkEpochId) {
		if (!readBranch(db, sessionId, parentBranchId!))
			throw new Error(`Parent recall branch does not exist: ${parentBranchId}`);
		if (collectBranchForks(db, sessionId, parentBranchId!).some(ancestor => ancestor.sourceBranchId === branchId)) {
			throw new Error("Recall branch lineage contains a cycle");
		}
		const forkEpoch = readEpoch(db, forkEpochId);
		if (!forkEpoch) throw new Error(`Fork projection epoch does not exist: ${forkEpochId}`);
		assertEpochIdentity(forkEpoch, sessionId, parentBranchId!);
		const parentHead = db
			.prepare("SELECT current_epoch_id FROM mctx_projection_heads WHERE session_id = ? AND branch_id = ?")
			.get(sessionId, parentBranchId!) as { current_epoch_id?: unknown } | undefined;
		if (!parentHead || String(parentHead.current_epoch_id) !== forkEpochId) {
			throw new Error("Fork epoch must be the parent branch's current projection epoch");
		}
		const max = db
			.prepare("SELECT COALESCE(MAX(admission_sequence), 0) AS value FROM mctx_recall_events WHERE epoch_id = ?")
			.get(forkEpochId) as { value: unknown };
		if (input.forkEventSequence! > Number(max.value))
			throw new Error("forkEventSequence exceeds the fork epoch tail");
		if (
			input.forkEventSequence! !== 0 &&
			!db
				.prepare("SELECT 1 FROM mctx_recall_events WHERE epoch_id = ? AND admission_sequence = ?")
				.get(forkEpochId, input.forkEventSequence!)
		) {
			throw new Error("forkEventSequence must be zero or an admitted event boundary");
		}
	}
	const existing = db
		.prepare("SELECT * FROM mctx_branch_lineage WHERE session_id = ? AND branch_id = ?")
		.get(sessionId, branchId) as Record<string, unknown> | undefined;
	if (existing) {
		assertImmutable("branch parent", existing.parent_branch_id ?? null, parentBranchId ?? null);
		assertImmutable("branch fork epoch", existing.fork_epoch_id ?? null, forkEpochId ?? null);
		assertImmutable("branch fork sequence", existing.fork_event_sequence ?? null, input.forkEventSequence ?? null);
		if (input.createdAt !== undefined)
			assertImmutable("branch creation time", Number(existing.created_at), input.createdAt);
		return;
	}
	db.prepare(
		`INSERT INTO mctx_branch_lineage
		 (session_id, branch_id, parent_branch_id, fork_epoch_id, fork_event_sequence, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(sessionId, branchId, parentBranchId ?? null, forkEpochId ?? null, input.forkEventSequence ?? null, now);
}

function readEvent(db: Database, row: Record<string, unknown>): RecallEvent {
	const body = asBytes(row.body);
	const eventId = String(row.event_id);
	const receipt = db
		.prepare("SELECT state FROM mctx_recall_presentation_receipts WHERE event_id = ? AND surface = 'tui'")
		.get(eventId) as { state?: unknown } | undefined;
	const sources = db
		.prepare(
			"SELECT source_id, source_kind, content_digest, project, agent_scope, remote_id, scope_json FROM mctx_recall_sources WHERE event_id = ?",
		)
		.all(eventId) as Array<Record<string, unknown>>;
	sources.sort((left, right) => compareText(String(left.source_id), String(right.source_id)));
	const dependencies = db
		.prepare("SELECT dependency_id, dependency_kind FROM mctx_recall_dependencies WHERE event_id = ?")
		.all(eventId) as Array<Record<string, unknown>>;
	dependencies.sort(
		(left, right) =>
			compareText(String(left.dependency_id), String(right.dependency_id)) ||
			compareText(String(left.dependency_kind), String(right.dependency_kind)),
	);
	return {
		eventId,
		sessionId: String(row.session_id),
		branchId: String(row.branch_id),
		userEntryAnchor: String(row.user_entry_anchor),
		epochId: String(row.epoch_id),
		admissionSequence: Number(row.admission_sequence),
		body,
		bodyDigest: String(row.body_digest),
		origin: String(row.origin) as RecallEventOrigin,
		promotionEligibility: String(row.promotion_eligibility) as PromotionEligibility,
		createdAt: Number(row.created_at),
		sources: sources.map(source => ({
			sourceId: String(source.source_id),
			sourceKind: String(source.source_kind),
			contentDigest: String(source.content_digest),
			project: String(source.project),
			...(typeof source.agent_scope === "string" ? { agentScope: source.agent_scope } : {}),
			...(typeof source.remote_id === "string" ? { remoteId: source.remote_id } : {}),
			scope: JSON.parse(String(source.scope_json)) as Record<string, string | number | boolean | null>,
		})),
		dependencies: dependencies.map(dependency => ({
			dependencyId: String(dependency.dependency_id),
			dependencyKind: String(dependency.dependency_kind),
		})),
		presentationState:
			receipt?.state === "presented" ? "presented" : receipt?.state === "claimed" ? "claimed" : "pending",
	};
}

function assertRetryMatches(
	input: RecallEventInput,
	persisted: RecallEvent,
	body: Uint8Array,
	sources: RecallSourceInput[],
	dependencies: RecallDependencyInput[],
): void {
	assertImmutable("event ID", persisted.eventId, deriveRecallEventId(input));
	if (!sameBytes(persisted.body, body)) throw new Error("Recall body conflicts with the immutable ledger");
	assertImmutable("body digest", persisted.bodyDigest, digest(body));
	assertImmutable("origin", persisted.origin, input.origin);
	assertImmutable("promotion eligibility", persisted.promotionEligibility, input.promotionEligibility);
	assertImmutable("sources", stableStringify(persisted.sources), stableStringify(sources));
	assertImmutable("dependencies", stableStringify(persisted.dependencies), stableStringify(dependencies));
	if (input.createdAt !== undefined) assertImmutable("creation time", persisted.createdAt, input.createdAt);
}

/** Atomically admits one immutable snapshot and its anti-feedback metadata. */
export function admitRecallEvent(db: Database, input: RecallEventInput): RecallEvent {
	ensureRecallLedgerSchema(db);
	const sessionId = ensureText(input.sessionId, "sessionId");
	const branchId = ensureText(input.branchId, "branchId");
	const epochId = ensureText(input.epochId, "epochId");
	const userEntryAnchor = ensureText(input.userEntryAnchor, "userEntryAnchor");
	const expectedEventId = deriveRecallEventId({ sessionId, branchId, epochId, userEntryAnchor });
	if (input.eventId !== undefined && ensureText(input.eventId, "eventId") !== expectedEventId) {
		throw new Error("Caller-supplied recall eventId conflicts with the stable anchored identity");
	}
	const body = new Uint8Array(input.body);
	const bodyDigest = digest(body);
	const sources = normalizeSources(input.sources);
	const dependencies = normalizeDependencies(input.dependencies);
	const now = ensureSafeInteger(input.createdAt ?? Date.now(), "Recall event creation time", 0);
	let event: RecallEvent | undefined;
	const write = () => {
		const epoch = readEpoch(db, epochId);
		if (!epoch) throw new Error(`Projection epoch does not exist: ${epochId}`);
		assertEpochIdentity(epoch, sessionId, branchId);
		const head = db
			.prepare("SELECT current_epoch_id FROM mctx_projection_heads WHERE session_id = ? AND branch_id = ?")
			.get(sessionId, branchId) as { current_epoch_id?: unknown } | undefined;
		if (!head || String(head.current_epoch_id) !== epochId) {
			throw new Error("Recall admission requires the branch's active projection epoch");
		}
		const existingRow = db
			.prepare(
				`SELECT * FROM mctx_recall_events WHERE session_id = ? AND branch_id = ?
			 AND user_entry_anchor = ? AND epoch_id = ?`,
			)
			.get(sessionId, branchId, userEntryAnchor, epochId) as Record<string, unknown> | undefined;
		if (existingRow) {
			event = readEvent(db, existingRow);
			assertRetryMatches(input, event, body, sources, dependencies);
			return;
		}
		const conflictingId = db.prepare("SELECT 1 FROM mctx_recall_events WHERE event_id = ?").get(expectedEventId);
		if (conflictingId) throw new Error("Stable recall eventId is already bound to different lineage");
		const sequenceRow = db
			.prepare("SELECT COALESCE(MAX(admission_sequence), 0) + 1 AS value FROM mctx_recall_events WHERE epoch_id = ?")
			.get(epochId) as { value: unknown };
		const admissionSequence = Number(sequenceRow.value);
		db.prepare(
			`INSERT INTO mctx_recall_events
			 (event_id, session_id, branch_id, user_entry_anchor, epoch_id, admission_sequence, body,
			  body_digest, origin, promotion_eligibility, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			expectedEventId,
			sessionId,
			branchId,
			userEntryAnchor,
			epochId,
			admissionSequence,
			body,
			bodyDigest,
			input.origin,
			input.promotionEligibility,
			now,
		);
		for (const source of sources) {
			db.prepare(
				`INSERT INTO mctx_recall_sources
				 (event_id, source_id, source_kind, content_digest, project, agent_scope, remote_id, scope_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				expectedEventId,
				source.sourceId,
				source.sourceKind,
				source.contentDigest,
				source.project,
				source.agentScope ?? null,
				source.remoteId ?? null,
				stableStringify(source.scope),
			);
		}
		for (const dependency of dependencies) {
			db.prepare(
				`INSERT INTO mctx_recall_dependencies(event_id, dependency_id, dependency_kind)
				 VALUES (?, ?, ?)`,
			).run(expectedEventId, dependency.dependencyId, dependency.dependencyKind);
		}
		db.prepare(
			`INSERT INTO mctx_recall_presentation_receipts(event_id, surface, state)
			 VALUES (?, 'tui', 'pending')`,
		).run(expectedEventId);
		const inserted = db.prepare("SELECT * FROM mctx_recall_events WHERE event_id = ?").get(expectedEventId) as Record<
			string,
			unknown
		>;
		event = readEvent(db, inserted);
	};
	db.transaction(write)();
	if (!event) throw new Error("Recall event admission failed");
	return event;
}

export function getRecallEvent(db: Database, eventId: string): RecallEvent | undefined {
	ensureRecallLedgerSchema(db);
	const row = db.prepare("SELECT * FROM mctx_recall_events WHERE event_id = ?").get(eventId) as
		| Record<string, unknown>
		| undefined;
	return row ? readEvent(db, row) : undefined;
}

/**
 * Registers a durable recovery/LKG reference. This is reference accounting
 * only: Ticket 02 never deletes or mutates the referenced snapshot.
 */
export function retainRecallRecoveryReference(db: Database, input: RecallRecoveryReferenceInput): void {
	ensureRecallLedgerSchema(db);
	const referenceId = ensureText(input.referenceId, "referenceId");
	const sessionId = ensureText(input.sessionId, "sessionId");
	const epochId = ensureText(input.epochId, "epochId");
	const referenceKind = ensureText(input.referenceKind, "referenceKind");
	const now = ensureSafeInteger(input.createdAt ?? Date.now(), "Recovery reference creation time", 0);
	const write = () => {
		const epoch = readEpoch(db, epochId);
		if (!epoch) throw new Error(`Recovery reference epoch does not exist: ${epochId}`);
		assertImmutable("recovery reference session", String(epoch.session_id), sessionId);
		const epochBranchId = String(epoch.branch_id);
		if (!readBranch(db, sessionId, epochBranchId)) {
			throw new Error(`Recovery reference branch does not exist: ${epochBranchId}`);
		}
		const persistedReachability = readPersistedReachability(db, epochId);
		const expectedReachability = assertReachableEpochs(db, {
			epochId,
			sessionId,
			branchId: epochBranchId,
			...(epoch.parent_epoch_id !== null && epoch.parent_epoch_id !== undefined
				? { parentEpochId: String(epoch.parent_epoch_id) }
				: {}),
			reason: String(epoch.reason),
			rendererVersion: String(epoch.renderer_version),
			...(epoch.earliest_changed_region !== null && epoch.earliest_changed_region !== undefined
				? { earliestChangedRegion: String(epoch.earliest_changed_region) }
				: {}),
			contractDigest: String(epoch.contract_digest),
			snapshotDigest: String(epoch.snapshot_digest),
			reachableEpochs: persistedReachability,
		});
		assertImmutable(
			"recovery reference reachability",
			stableStringify(persistedReachability),
			stableStringify(expectedReachability),
		);
		if (input.eventId !== undefined) {
			const event = db
				.prepare(
					`SELECT event.session_id, event.epoch_id FROM mctx_recall_events event
					 JOIN mctx_projection_epoch_reachability reachable
					   ON reachable.epoch_id = ? AND reachable.reachable_epoch_id = event.epoch_id
					 WHERE event.event_id = ?
					 AND (reachable.max_event_sequence IS NULL OR event.admission_sequence <= reachable.max_event_sequence)`,
				)
				.get(epochId, ensureText(input.eventId, "eventId")) as
				| { session_id?: unknown; epoch_id?: unknown }
				| undefined;
			if (!event) throw new Error(`Recovery reference event does not exist: ${input.eventId}`);
			assertImmutable("recovery reference event session", String(event.session_id), sessionId);
		}
		const existing = db.prepare("SELECT * FROM mctx_recall_recovery_refs WHERE reference_id = ?").get(referenceId) as
			| Record<string, unknown>
			| undefined;
		if (existing) {
			assertImmutable("recovery reference session", String(existing.session_id), sessionId);
			assertImmutable("recovery reference epoch", String(existing.epoch_id), epochId);
			assertImmutable("recovery reference event", existing.event_id ?? null, input.eventId ?? null);
			assertImmutable("recovery reference kind", String(existing.reference_kind), referenceKind);
			if (input.createdAt !== undefined)
				assertImmutable("recovery reference creation time", Number(existing.created_at), input.createdAt);
			return;
		}
		db.prepare(
			`INSERT INTO mctx_recall_recovery_refs
			 (reference_id, session_id, epoch_id, event_id, reference_kind, state, created_at)
			 VALUES (?, ?, ?, ?, ?, 'active', ?)`,
		).run(referenceId, sessionId, epochId, input.eventId ?? null, referenceKind, now);
	};
	db.transaction(write)();
}

/** Releases one recovery reference; releasing is the only state transition. */
export function releaseRecallRecoveryReference(db: Database, referenceId: string, releasedAt = Date.now()): boolean {
	ensureRecallLedgerSchema(db);
	ensureSafeInteger(releasedAt, "Recovery reference release time", 0);
	const existing = db
		.prepare("SELECT created_at FROM mctx_recall_recovery_refs WHERE reference_id = ? AND state = 'active'")
		.get(ensureText(referenceId, "referenceId")) as { created_at?: unknown } | undefined;
	if (existing && releasedAt < Number(existing.created_at)) {
		throw new Error("Recovery reference release time cannot precede its creation time");
	}
	const result = db
		.prepare(
			`UPDATE mctx_recall_recovery_refs
			 SET state = 'released', released_at = ?
			 WHERE reference_id = ? AND state = 'active'`,
		)
		.run(releasedAt, ensureText(referenceId, "referenceId"));
	return Number(result.changes) === 1;
}

/** Replays only epochs explicitly reachable from the selected branch's current epoch. */
export function listActiveBranchRecallEvents(db: Database, sessionId: string, branchId: string): RecallEvent[] {
	ensureRecallLedgerSchema(db);
	const rows = db
		.prepare(
			`SELECT event.* FROM mctx_projection_heads head
		 JOIN mctx_projection_epoch_reachability reachable ON reachable.epoch_id = head.current_epoch_id
		 JOIN mctx_recall_events event ON event.epoch_id = reachable.reachable_epoch_id
		 WHERE head.session_id = ? AND head.branch_id = ?
		 AND (reachable.max_event_sequence IS NULL OR event.admission_sequence <= reachable.max_event_sequence)
		 ORDER BY reachable.lineage_depth DESC, event.admission_sequence, event.event_id`,
		)
		.all(ensureText(sessionId, "sessionId"), ensureText(branchId, "branchId")) as Array<Record<string, unknown>>;
	return rows.map(row => readEvent(db, row));
}

/** Atomically claims a pending receipt. Duplicate presenters cannot both win. */
export function claimRecallPresentation(
	db: Database,
	eventId: string,
	claimToken: string,
	claimedAt = Date.now(),
	surface = "tui",
	leaseMs = RECALL_PRESENTATION_CLAIM_LEASE_MS,
): boolean {
	ensureRecallLedgerSchema(db);
	if (!Number.isSafeInteger(claimedAt) || claimedAt < 0 || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
		throw new Error("Presentation claim timestamp and lease must be safe integers");
	}
	const result = db
		.prepare(
			`UPDATE mctx_recall_presentation_receipts
			 SET state = 'claimed', claim_token = ?, claimed_at = ?, presented_at = NULL
			 WHERE event_id = ? AND surface = ? AND
			 (state = 'pending' OR
			  (state = 'claimed' AND (claimed_at IS NULL OR claimed_at + ? <= ?)))`,
		)
		.run(
			ensureText(claimToken, "claimToken"),
			claimedAt,
			ensureText(eventId, "eventId"),
			ensureText(surface, "surface"),
			leaseMs,
			claimedAt,
		);
	return Number(result.changes) === 1;
}

/** Records delivery only for the presenter that owns the claim. */
export function completeRecallPresentation(
	db: Database,
	eventId: string,
	claimToken: string,
	presentedAt = Date.now(),
	surface = "tui",
): boolean {
	ensureRecallLedgerSchema(db);
	ensureSafeInteger(presentedAt, "Presentation completion time", 0);
	const receipt = db
		.prepare(
			`SELECT claimed_at FROM mctx_recall_presentation_receipts
			 WHERE event_id = ? AND surface = ? AND state = 'claimed' AND claim_token = ?`,
		)
		.get(ensureText(eventId, "eventId"), ensureText(surface, "surface"), ensureText(claimToken, "claimToken")) as
		| { claimed_at?: unknown }
		| undefined;
	if (receipt?.claimed_at !== undefined && presentedAt < Number(receipt.claimed_at)) {
		throw new Error("Presentation completion time cannot precede its claim time");
	}
	const result = db
		.prepare(
			`UPDATE mctx_recall_presentation_receipts
			 SET state = 'presented', presented_at = ?
			 WHERE event_id = ? AND surface = ? AND state = 'claimed' AND claim_token = ?`,
		)
		.run(
			presentedAt,
			ensureText(eventId, "eventId"),
			ensureText(surface, "surface"),
			ensureText(claimToken, "claimToken"),
		);
	return Number(result.changes) === 1;
}

/** Reports references only; Ticket 02 deliberately does not delete retained snapshots. */
export function getRecallRetention(db: Database, eventId: string): RecallRetention | undefined {
	ensureRecallLedgerSchema(db);
	const event = db
		.prepare("SELECT epoch_id, admission_sequence FROM mctx_recall_events WHERE event_id = ?")
		.get(eventId) as { epoch_id: unknown; admission_sequence: unknown } | undefined;
	if (!event) return undefined;
	const epochId = String(event.epoch_id);
	const sequence = Number(event.admission_sequence);
	const referencedByEpoch = Boolean(
		db.prepare("SELECT 1 FROM mctx_projection_heads WHERE current_epoch_id = ? LIMIT 1").get(epochId),
	);
	const referencedByBranch = Boolean(
		db
			.prepare(
				`SELECT 1 FROM mctx_projection_heads head
		 JOIN mctx_projection_epoch_reachability reachable ON reachable.epoch_id = head.current_epoch_id
		 WHERE reachable.reachable_epoch_id = ?
		 AND (reachable.max_event_sequence IS NULL OR ? <= reachable.max_event_sequence) LIMIT 1`,
			)
			.get(epochId, sequence),
	);
	const referencedByDependency = Boolean(
		db
			.prepare(
				`SELECT 1 FROM mctx_recall_dependencies dependency
				 JOIN mctx_recall_events owner ON owner.event_id = dependency.event_id
				 JOIN mctx_projection_epoch_reachability reachable ON reachable.reachable_epoch_id = owner.epoch_id
				 JOIN mctx_projection_heads head ON head.current_epoch_id = reachable.epoch_id
				 WHERE dependency.dependency_id = ?
				 AND (reachable.max_event_sequence IS NULL OR owner.admission_sequence <= reachable.max_event_sequence)
				 LIMIT 1`,
			)
			.get(eventId),
	);
	const referencedByPresentation = Boolean(
		db
			.prepare(
				`SELECT 1 FROM mctx_recall_presentation_receipts receipt
			 JOIN mctx_recall_events owner ON owner.event_id = receipt.event_id
			 JOIN mctx_projection_epoch_reachability reachable ON reachable.reachable_epoch_id = owner.epoch_id
			 JOIN mctx_projection_heads head ON head.current_epoch_id = reachable.epoch_id
				 WHERE receipt.event_id = ? AND receipt.state != 'presented'
			 AND (reachable.max_event_sequence IS NULL OR owner.admission_sequence <= reachable.max_event_sequence)
			 LIMIT 1`,
			)
			.get(eventId),
	);
	const referencedByRecovery = Boolean(
		db
			.prepare(
				`SELECT 1 FROM mctx_recall_recovery_refs reference
				 JOIN mctx_projection_epoch_reachability reachable ON reachable.epoch_id = reference.epoch_id
				 WHERE reference.state = 'active'
				 AND reachable.reachable_epoch_id = ?
				 AND (reachable.max_event_sequence IS NULL OR ? <= reachable.max_event_sequence)
				 AND (reference.event_id IS NULL OR reference.event_id = ?)
				 LIMIT 1`,
			)
			.get(epochId, sequence, eventId),
	);
	return {
		eventId,
		referencedByEpoch,
		referencedByBranch,
		referencedByDependency,
		referencedByPresentation,
		referencedByRecovery,
		eligible:
			!referencedByEpoch &&
			!referencedByBranch &&
			!referencedByDependency &&
			!referencedByPresentation &&
			!referencedByRecovery,
	};
}

/** Deletes immutable recall snapshots only after all established retention references have disappeared. */
export function gcUnreachableRecall(db: Database): { deletedEvents: number } {
	ensureRecallLedgerSchema(db);
	let deletedEvents = 0;
	db.transaction(() => {
		const eventIds = db.prepare("SELECT event_id FROM mctx_recall_events ORDER BY event_id").all() as Array<{
			event_id: unknown;
		}>;
		for (const row of eventIds) {
			const eventId = String(row.event_id);
			if (!getRecallRetention(db, eventId)?.eligible) continue;
			db.prepare("DELETE FROM mctx_recall_presentation_receipts WHERE event_id = ?").run(eventId);
			db.prepare("DELETE FROM mctx_recall_sources WHERE event_id = ?").run(eventId);
			db.prepare("DELETE FROM mctx_recall_dependencies WHERE event_id = ?").run(eventId);
			db.prepare("DELETE FROM mctx_recall_recovery_refs WHERE event_id = ?").run(eventId);
			const result = db.prepare("DELETE FROM mctx_recall_events WHERE event_id = ?").run(eventId);
			deletedEvents += Number(result.changes);
		}
	})();
	return { deletedEvents };
}
