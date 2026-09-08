import * as crypto from "node:crypto";
import type { Database } from "../shared/sqlite";

/**
 * Durable state for the model-bound Context Projection.
 *
 * The projection is deliberately separate from the raw session transcript and
 * from AgentMemory. It stores the exact bytes that mctx published, plus the
 * append segments needed to audit and replay those bytes after a restart.
 */
export const CONTEXT_PROJECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mctx_context_projection_states (
  projection_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  contract_digest TEXT NOT NULL,
  baseline BLOB NOT NULL,
  body_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'withdrawn')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, branch_id, epoch_id),
  FOREIGN KEY(epoch_id, session_id, branch_id)
    REFERENCES mctx_projection_epochs(epoch_id, session_id, branch_id)
);
CREATE TABLE IF NOT EXISTS mctx_context_projection_appends (
  projection_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  body BLOB NOT NULL,
  body_digest TEXT NOT NULL,
  PRIMARY KEY(projection_id, event_id),
  UNIQUE(projection_id, sequence),
  FOREIGN KEY(projection_id) REFERENCES mctx_context_projection_states(projection_id)
    ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mctx_context_projection_heads (
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'withdrawn')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, branch_id),
  FOREIGN KEY(projection_id) REFERENCES mctx_context_projection_states(projection_id)
);
CREATE TABLE IF NOT EXISTS mctx_context_projection_transitions (
  transition_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  from_epoch_id TEXT,
  to_epoch_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  earliest_changed_region TEXT,
  from_digest TEXT,
  to_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, branch_id, to_epoch_id)
);
CREATE INDEX IF NOT EXISTS mctx_context_projection_appends_order_idx
  ON mctx_context_projection_appends(projection_id, sequence);
CREATE INDEX IF NOT EXISTS mctx_context_projection_transitions_branch_idx
  ON mctx_context_projection_transitions(session_id, branch_id, created_at);
`;

const MAX_SAFE_TIMESTAMP = Number.MAX_SAFE_INTEGER;

export type ContextProjectionState = "active" | "withdrawn";

export type ContextProjectionContract = {
	rendererVersion: string;
	modelDigest: string;
	systemDigest: string;
	toolsDigest: string;
};

export type ContextProjectionRecord = {
	projectionId: string;
	sessionId: string;
	branchId: string;
	epochId: string;
	rendererVersion: string;
	contractDigest: string;
	baseline: Uint8Array;
	body: Uint8Array;
	bodyDigest: string;
	state: ContextProjectionState;
	appendCount: number;
	createdAt: number;
	updatedAt: number;
};

export type ContextProjectionIdentity = {
	sessionId: string;
	branchId: string;
	epochId: string;
	rendererVersion: string;
	contractDigest: string;
};

export type ContextProjectionBootstrapInput = ContextProjectionIdentity & {
	baseline: Uint8Array;
	createdAt?: number;
};

export type ContextProjectionAppendInput = {
	sessionId: string;
	branchId: string;
	epochId: string;
	eventId: string;
	body: Uint8Array;
	expectedBodyDigest?: string;
	createdAt?: number;
};

export type ContextProjectionTransitionInput = ContextProjectionIdentity & {
	fromEpochId?: string;
	baseline: Uint8Array;
	reason: string;
	earliestChangedRegion?: string;
	withdrawsRecovery?: boolean;
	createdAt?: number;
};

type StateRow = {
	projection_id: unknown;
	session_id: unknown;
	branch_id: unknown;
	epoch_id: unknown;
	renderer_version: unknown;
	contract_digest: unknown;
	baseline: unknown;
	body_digest: unknown;
	state: unknown;
	created_at: unknown;
	updated_at: unknown;
};

type HeadRow = {
	projection_id: unknown;
	state: unknown;
};

function ensureText(value: string, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must not be empty`);
	}
	return value;
}

function ensureTimestamp(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_TIMESTAMP) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function copyBytes(value: Uint8Array): Uint8Array {
	if (!(value instanceof Uint8Array)) throw new Error("Projection body must be binary");
	return new Uint8Array(value);
}

function readBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return new Uint8Array(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	throw new Error("Projection database body is not binary");
}

function digest(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const size = parts.reduce((total, part) => total + part.length, 0);
	const result = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function frame(value: string): Uint8Array {
	const bytes = new TextEncoder().encode(value);
	const prefix = new TextEncoder().encode(`${bytes.length}:`);
	return concatBytes([prefix, bytes]);
}

function assertIdentityText(identity: ContextProjectionIdentity): ContextProjectionIdentity {
	return {
		sessionId: ensureText(identity.sessionId, "sessionId"),
		branchId: ensureText(identity.branchId, "branchId"),
		epochId: ensureText(identity.epochId, "epochId"),
		rendererVersion: ensureText(identity.rendererVersion, "rendererVersion"),
		contractDigest: ensureText(identity.contractDigest, "contractDigest"),
	};
}

function readCurrentHead(db: Database, sessionId: string, branchId: string): HeadRow | undefined {
	return db
		.prepare("SELECT projection_id, state FROM mctx_context_projection_heads WHERE session_id = ? AND branch_id = ?")
		.get(sessionId, branchId) as HeadRow | undefined;
}

function readState(db: Database, projectionId: string): StateRow | undefined {
	return db.prepare("SELECT * FROM mctx_context_projection_states WHERE projection_id = ?").get(projectionId) as
		| StateRow
		| undefined;
}

function readProjectionBody(
	db: Database,
	row: StateRow,
	validateDigest = true,
): { baseline: Uint8Array; body: Uint8Array; appendCount: number } {
	const baseline = readBytes(row.baseline);
	const appends = db
		.prepare("SELECT body FROM mctx_context_projection_appends WHERE projection_id = ? ORDER BY sequence")
		.all(String(row.projection_id))
		.map(value => readBytes((value as { body: unknown }).body));
	const body = concatBytes([baseline, ...appends]);
	if (validateDigest && digest(body) !== String(row.body_digest))
		throw new Error("Context Projection digest mismatch");
	return { baseline, body, appendCount: appends.length };
}

function toRecord(db: Database, row: StateRow): ContextProjectionRecord {
	const projected = readProjectionBody(db, row);
	return {
		projectionId: String(row.projection_id),
		sessionId: String(row.session_id),
		branchId: String(row.branch_id),
		epochId: String(row.epoch_id),
		rendererVersion: String(row.renderer_version),
		contractDigest: String(row.contract_digest),
		baseline: projected.baseline,
		body: projected.body,
		bodyDigest: String(row.body_digest),
		state: String(row.state) as ContextProjectionState,
		appendCount: projected.appendCount,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function ensureProjectionSchemaDependency(db: Database, identity: ContextProjectionIdentity): void {
	const epoch = db
		.prepare("SELECT session_id, branch_id FROM mctx_projection_epochs WHERE epoch_id = ?")
		.get(identity.epochId) as { session_id?: unknown; branch_id?: unknown } | undefined;
	if (!epoch) throw new Error(`Projection epoch does not exist: ${identity.epochId}`);
	if (String(epoch.session_id) !== identity.sessionId || String(epoch.branch_id) !== identity.branchId) {
		throw new Error("Context Projection epoch identity conflicts with the ledger");
	}
}

function contractDigest(contract: ContextProjectionContract): string {
	const normalized = [
		ensureText(contract.rendererVersion, "rendererVersion"),
		ensureText(contract.modelDigest, "modelDigest"),
		ensureText(contract.systemDigest, "systemDigest"),
		ensureText(contract.toolsDigest, "toolsDigest"),
	].map(frame);
	return digest(concatBytes(normalized));
}

export function deriveContextProjectionId(identity: ContextProjectionIdentity): string {
	const normalized = assertIdentityText(identity);
	return `projection-${digest(
		concatBytes([
			frame(normalized.sessionId),
			frame(normalized.branchId),
			frame(normalized.epochId),
			frame(normalized.rendererVersion),
			frame(normalized.contractDigest),
		]),
	)}`;
}

export function deriveContextContractDigest(contract: ContextProjectionContract): string {
	return contractDigest(contract);
}

export function ensureContextProjectionSchema(db: Database): void {
	db.exec(CONTEXT_PROJECTION_SCHEMA_SQL);
}

/** Creates the first immutable baseline for a branch and publishes it atomically. */
export function bootstrapContextProjection(
	db: Database,
	input: ContextProjectionBootstrapInput,
): ContextProjectionRecord {
	ensureContextProjectionSchema(db);
	const identity = assertIdentityText(input);
	const baseline = copyBytes(input.baseline);
	const now = ensureTimestamp(input.createdAt ?? Date.now(), "Projection creation time");
	const projectionId = deriveContextProjectionId(identity);
	let result: ContextProjectionRecord | undefined;
	db.transaction(() => {
		ensureProjectionSchemaDependency(db, identity);
		const existing = readState(db, projectionId);
		if (existing) {
			if (String(existing.state) !== "active") throw new Error("Cannot bootstrap a withdrawn projection");
			const current = toRecord(db, existing);
			if (current.bodyDigest !== digest(baseline))
				throw new Error("Projection baseline conflicts with the immutable ledger");
			result = current;
			return;
		}
		const head = readCurrentHead(db, identity.sessionId, identity.branchId);
		if (head) throw new Error("Projection branch is already bootstrapped");
		db.prepare(
			`INSERT INTO mctx_context_projection_states
			 (projection_id, session_id, branch_id, epoch_id, renderer_version, contract_digest,
			  baseline, body_digest, state, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
		).run(
			projectionId,
			identity.sessionId,
			identity.branchId,
			identity.epochId,
			identity.rendererVersion,
			identity.contractDigest,
			baseline,
			digest(baseline),
			now,
			now,
		);
		db.prepare(
			`INSERT INTO mctx_context_projection_heads(session_id, branch_id, projection_id, state, updated_at)
			 VALUES (?, ?, ?, 'active', ?)`,
		).run(identity.sessionId, identity.branchId, projectionId, now);
		result = toRecord(db, readState(db, projectionId)!);
	})();
	if (!result) throw new Error("Context Projection bootstrap failed");
	return result;
}

/**
 * Appends one already-admitted event. The existing bytes and contract are
 * checked before writing, so a retry is a no-op and a changed retry fails.
 */
export function appendContextProjection(db: Database, input: ContextProjectionAppendInput): ContextProjectionRecord {
	ensureContextProjectionSchema(db);
	const sessionId = ensureText(input.sessionId, "sessionId");
	const branchId = ensureText(input.branchId, "branchId");
	const epochId = ensureText(input.epochId, "epochId");
	const eventId = ensureText(input.eventId, "eventId");
	const body = copyBytes(input.body);
	const bodyDigest = digest(body);
	if (
		input.expectedBodyDigest !== undefined &&
		ensureText(input.expectedBodyDigest, "expectedBodyDigest") !== bodyDigest
	) {
		throw new Error("Projection append body digest does not match the admitted bytes");
	}
	const now = ensureTimestamp(input.createdAt ?? Date.now(), "Projection append time");
	let result: ContextProjectionRecord | undefined;
	db.transaction(() => {
		const head = readCurrentHead(db, sessionId, branchId);
		if (!head || String(head.state) !== "active") throw new Error("Projection branch is not active");
		const row = readState(db, String(head.projection_id));
		if (!row || String(row.state) !== "active") throw new Error("Projection head is not active");
		if (String(row.epoch_id) !== epochId) throw new Error("Projection append epoch is not current");
		const existing = db
			.prepare("SELECT body_digest FROM mctx_context_projection_appends WHERE projection_id = ? AND event_id = ?")
			.get(String(row.projection_id), eventId) as { body_digest?: unknown } | undefined;
		if (existing) {
			if (String(existing.body_digest) !== bodyDigest)
				throw new Error("Projection append conflicts with the immutable ledger");
			result = toRecord(db, row);
			return;
		}
		const sequence = Number(
			(
				db
					.prepare(
						"SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM mctx_context_projection_appends WHERE projection_id = ?",
					)
					.get(String(row.projection_id)) as { sequence: unknown }
			).sequence,
		);
		if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("Projection append sequence is unsafe");
		db.prepare(
			`INSERT INTO mctx_context_projection_appends
			 (projection_id, event_id, sequence, body, body_digest) VALUES (?, ?, ?, ?, ?)`,
		).run(String(row.projection_id), eventId, sequence, body, bodyDigest);
		const projected = readProjectionBody(db, row, false);
		db.prepare(
			"UPDATE mctx_context_projection_states SET body_digest = ?, updated_at = ? WHERE projection_id = ?",
		).run(digest(projected.body), now, String(row.projection_id));
		db.prepare("UPDATE mctx_context_projection_heads SET updated_at = ? WHERE session_id = ? AND branch_id = ?").run(
			now,
			sessionId,
			branchId,
		);
		result = toRecord(db, readState(db, String(row.projection_id))!);
	})();
	if (!result) throw new Error("Context Projection append failed");
	return result;
}

/** Publishes a non-append change as a new epoch. Withdrawal disables LKG fallback. */
export function transitionContextProjection(
	db: Database,
	input: ContextProjectionTransitionInput,
): ContextProjectionRecord {
	ensureContextProjectionSchema(db);
	const identity = assertIdentityText(input);
	const baseline = copyBytes(input.baseline);
	const reason = ensureText(input.reason, "transition reason");
	const earliestChangedRegion =
		input.earliestChangedRegion === undefined
			? null
			: ensureText(input.earliestChangedRegion, "earliestChangedRegion");
	const fromEpochId = input.fromEpochId === undefined ? undefined : ensureText(input.fromEpochId, "fromEpochId");
	const now = ensureTimestamp(input.createdAt ?? Date.now(), "Projection transition time");
	const projectionId = deriveContextProjectionId(identity);
	const transitionId = `transition-${digest(concatBytes([frame(identity.sessionId), frame(identity.branchId), frame(identity.epochId)]))}`;
	const withdrawn = input.withdrawsRecovery === true;
	let result: ContextProjectionRecord | undefined;
	db.transaction(() => {
		ensureProjectionSchemaDependency(db, identity);
		const existing = readState(db, projectionId);
		if (existing) {
			const current = toRecord(db, existing);
			if (current.state !== (withdrawn ? "withdrawn" : "active")) {
				throw new Error("Projection transition conflicts with the immutable ledger");
			}
			if (current.bodyDigest !== digest(baseline)) {
				throw new Error("Projection transition baseline conflicts with the immutable ledger");
			}
			const currentHead = readCurrentHead(db, identity.sessionId, identity.branchId);
			if (!currentHead || String(currentHead.projection_id) !== projectionId) {
				throw new Error("Projection transition epoch is not current");
			}
			result = current;
			return;
		}
		const head = readCurrentHead(db, identity.sessionId, identity.branchId);
		if (!head || String(head.state) !== "active") throw new Error("Projection transition requires an active head");
		const previous = readState(db, String(head.projection_id));
		if (!previous) throw new Error("Projection transition head is missing");
		if (fromEpochId !== undefined && String(previous.epoch_id) !== fromEpochId) {
			throw new Error("Projection transition source epoch is not current");
		}
		if (String(previous.epoch_id) === identity.epochId)
			throw new Error("Projection transition must create a new epoch");
		if (readState(db, projectionId)) throw new Error("Projection transition epoch already exists");
		const previousProjection = toRecord(db, previous);
		db.prepare(
			`INSERT INTO mctx_context_projection_states
			 (projection_id, session_id, branch_id, epoch_id, renderer_version, contract_digest,
			  baseline, body_digest, state, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			projectionId,
			identity.sessionId,
			identity.branchId,
			identity.epochId,
			identity.rendererVersion,
			identity.contractDigest,
			baseline,
			digest(baseline),
			withdrawn ? "withdrawn" : "active",
			now,
			now,
		);
		db.prepare(
			`INSERT INTO mctx_context_projection_transitions
			 (transition_id, session_id, branch_id, from_epoch_id, to_epoch_id, reason,
			  earliest_changed_region, from_digest, to_digest, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			transitionId,
			identity.sessionId,
			identity.branchId,
			fromEpochId ?? String(previous.epoch_id),
			identity.epochId,
			reason,
			earliestChangedRegion,
			previousProjection.bodyDigest,
			digest(baseline),
			now,
		);
		db.prepare(
			`UPDATE mctx_context_projection_heads SET projection_id = ?, state = ?, updated_at = ?
			 WHERE session_id = ? AND branch_id = ?`,
		).run(projectionId, withdrawn ? "withdrawn" : "active", now, identity.sessionId, identity.branchId);
		result = toRecord(db, readState(db, projectionId)!);
	})();
	if (!result) throw new Error("Context Projection transition failed");
	return result;
}

export function readContextProjection(
	db: Database,
	sessionId: string,
	branchId: string,
): ContextProjectionRecord | undefined {
	ensureContextProjectionSchema(db);
	const head = readCurrentHead(db, ensureText(sessionId, "sessionId"), ensureText(branchId, "branchId"));
	if (!head || String(head.state) !== "active") return undefined;
	const row = readState(db, String(head.projection_id));
	return row ? toRecord(db, row) : undefined;
}

/** The active head is the last-known-good snapshot until a new publication commits. */
export const readLastKnownGoodContextProjection = readContextProjection;

export function listContextProjectionTransitions(
	db: Database,
	sessionId: string,
	branchId: string,
): Array<{
	transitionId: string;
	fromEpochId: string | null;
	toEpochId: string;
	reason: string;
	earliestChangedRegion: string | null;
	fromDigest: string | null;
	toDigest: string;
	createdAt: number;
}> {
	ensureContextProjectionSchema(db);
	const rows = db
		.prepare(
			`SELECT transition_id, from_epoch_id, to_epoch_id, reason, earliest_changed_region,
			 from_digest, to_digest, created_at
			 FROM mctx_context_projection_transitions
			 WHERE session_id = ? AND branch_id = ? ORDER BY created_at, rowid`,
		)
		.all(ensureText(sessionId, "sessionId"), ensureText(branchId, "branchId")) as Array<Record<string, unknown>>;
	return rows.map(row => ({
		transitionId: String(row.transition_id),
		fromEpochId: row.from_epoch_id === null ? null : String(row.from_epoch_id),
		toEpochId: String(row.to_epoch_id),
		reason: String(row.reason),
		earliestChangedRegion: row.earliest_changed_region === null ? null : String(row.earliest_changed_region),
		fromDigest: row.from_digest === null ? null : String(row.from_digest),
		toDigest: String(row.to_digest),
		createdAt: Number(row.created_at),
	}));
}
