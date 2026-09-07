import { createHash } from "node:crypto";
import type { AgentMemoryClientPort, RememberInput } from "./client";
import type { Database } from "../core/shared/sqlite";

export const AGENTMEMORY_OUTBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agentmemory_observation_links (
  source_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  observation_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agentmemory_turn_taint (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  host_entry_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE TABLE IF NOT EXISTS agentmemory_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_hash TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  agent_id TEXT,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER NOT NULL,
  delivered_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agentmemory_outbox_ready_idx
  ON agentmemory_outbox (state, next_attempt_at, lease_until);
`;

export type HistorianCandidateForOutbox = {
	project: string;
	agentId?: string;
	type?: "pattern" | "preference" | "architecture" | "bug" | "workflow" | "fact";
	content: string;
	concepts?: readonly string[];
	files?: readonly string[];
	sourceObservationIds?: readonly string[];
};
type AgentMemoryCandidateType = NonNullable<HistorianCandidateForOutbox["type"]>;

export type OutboxRow = {
	id: number;
	candidateHash: string;
	project: string;
	agentId?: string;
	payload: RememberInput;
	attempts: number;
	leaseOwner: string;
};

export type OutboxEnqueueResult = { inserted: boolean; candidateHash: string; id?: number };

function normalizedText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function normalizedList(values: readonly string[] | undefined): string[] {
	return [...new Set((values ?? []).map(normalizedText).filter(Boolean))].sort();
}

function normalizedCandidate(candidate: HistorianCandidateForOutbox): RememberInput & { candidateHash: string } {
	const type = candidate.type?.trim() as AgentMemoryCandidateType | undefined;
	const payload: RememberInput = {
		content: normalizedText(candidate.content),
		project: normalizedText(candidate.project),
		...(candidate.agentId?.trim() ? { agentId: normalizedText(candidate.agentId) } : {}),
		...(type ? { type } : {}),
		...(normalizedList(candidate.concepts).length ? { concepts: normalizedList(candidate.concepts) } : {}),
		...(normalizedList(candidate.files).length ? { files: normalizedList(candidate.files) } : {}),
		...(normalizedList(candidate.sourceObservationIds).length
			? { sourceObservationIds: normalizedList(candidate.sourceObservationIds) }
			: {}),
	};
	const hashInput = JSON.stringify({
		project: payload.project,
		agentId: payload.agentId ?? null,
		type: payload.type ?? "fact",
		content: payload.content,
		concepts: payload.concepts ?? [],
		files: payload.files ?? [],
	});
	return { ...payload, candidateHash: createHash("sha256").update(hashInput).digest("hex") };
}

function rememberCandidateHash(payload: RememberInput): string {
	const type = payload.type as AgentMemoryCandidateType | undefined;
	return normalizedCandidate({
		project: payload.project,
		...(payload.agentId ? { agentId: payload.agentId } : {}),
		...(type ? { type } : {}),
		content: payload.content,
		...(payload.concepts ? { concepts: payload.concepts } : {}),
		...(payload.files ? { files: payload.files } : {}),
	}).candidateHash;
}

export function candidateHash(candidate: HistorianCandidateForOutbox): string {
	return normalizedCandidate(candidate).candidateHash;
}

export function ensureAgentMemoryOutboxSchema(db: Database): void {
	db.exec(AGENTMEMORY_OUTBOX_SCHEMA_SQL);
	try {
		db.exec("ALTER TABLE agentmemory_observation_links ADD COLUMN observation_id TEXT");
	} catch {
		/* already migrated */
	}
	try {
		db.exec("ALTER TABLE agentmemory_turn_taint ADD COLUMN host_entry_id TEXT");
	} catch {
		/* already migrated */
	}
}

export function linkAgentMemoryObservation(
	db: Database,
	input: {
		sourceId: string;
		sessionId: string;
		project: string;
		sourceKind: string;
		content: string;
		observationId: string;
		now?: number;
	},
): void {
	ensureAgentMemoryOutboxSchema(db);
	db.prepare(
		`INSERT INTO agentmemory_observation_links(source_id, session_id, project, source_kind, content_fingerprint, observation_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET session_id = excluded.session_id, project = excluded.project, source_kind = excluded.source_kind, content_fingerprint = excluded.content_fingerprint, observation_id = excluded.observation_id`,
	).run(
		input.sourceId,
		input.sessionId,
		input.project,
		input.sourceKind,
		createHash("sha256").update(normalizedText(input.content)).digest("hex"),
		input.observationId,
		input.now ?? Date.now(),
	);
}

export function resolveLinkedObservationId(
	db: Database,
	input: {
		sourceId: string;
		sessionId: string;
		project: string;
		sourceKinds: readonly string[];
		content: string;
	},
): string | undefined {
	ensureAgentMemoryOutboxSchema(db);
	const row = db
		.prepare(
			"SELECT observation_id, session_id, project, source_kind, content_fingerprint FROM agentmemory_observation_links WHERE source_id = ?",
		)
		.get(input.sourceId) as
		| {
				observation_id?: unknown;
				session_id?: unknown;
				project?: unknown;
				source_kind?: unknown;
				content_fingerprint?: unknown;
		  }
		| undefined;
	if (
		row?.session_id !== input.sessionId ||
		row.project !== input.project ||
		typeof row.source_kind !== "string" ||
		!input.sourceKinds.includes(row.source_kind) ||
		row.content_fingerprint !== createHash("sha256").update(normalizedText(input.content)).digest("hex")
	)
		return undefined;
	return typeof row?.observation_id === "string" && row.observation_id.trim() ? row.observation_id : undefined;
}

/** Atomically publish local Window state and its remote candidate. */
export function commitHistorianPublication(
	db: Database,
	args: {
		candidate: HistorianCandidateForOutbox;
		writeWindow: () => void;
		now?: number;
	},
): OutboxEnqueueResult {
	ensureAgentMemoryOutboxSchema(db);
	const candidate = normalizedCandidate(args.candidate);
	const now = args.now ?? Date.now();
	let inserted = false;
	let id: number | undefined;
	const publish = () => {
		args.writeWindow();
		const result = db
			.prepare(
				`INSERT OR IGNORE INTO agentmemory_outbox
				 (candidate_hash, project, agent_id, payload_json, next_attempt_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				candidate.candidateHash,
				candidate.project,
				candidate.agentId ?? null,
				JSON.stringify(candidate),
				now,
				now,
			);
		inserted = Number(result.changes) > 0;
		if (inserted) id = Number(result.lastInsertRowid);
	};
	const state = db as unknown as { inTransaction?: unknown; isTransaction?: unknown };
	if (state.inTransaction === true || state.isTransaction === true) publish();
	else db.transaction(publish)();
	return { inserted, candidateHash: candidate.candidateHash, ...(id !== undefined ? { id } : {}) };
}

/** Queue an explicit save without pretending the remote service accepted it. */
export function enqueueAgentMemorySave(db: Database, input: RememberInput, now = Date.now()): OutboxEnqueueResult {
	return commitHistorianPublication(db, {
		candidate: {
			content: input.content,
			project: input.project,
			...(input.agentId ? { agentId: input.agentId } : {}),
			...(input.type ? { type: input.type as AgentMemoryCandidateType } : {}),
			...(input.concepts ? { concepts: input.concepts } : {}),
			...(input.files ? { files: input.files } : {}),
			...(input.sourceObservationIds ? { sourceObservationIds: input.sourceObservationIds } : {}),
		},
		writeWindow: () => undefined,
		now,
	});
}

function readRow(row: Record<string, unknown>): OutboxRow {
	return {
		id: Number(row.id),
		candidateHash: String(row.candidate_hash),
		project: String(row.project),
		...(typeof row.agent_id === "string" ? { agentId: row.agent_id } : {}),
		payload: (() => {
			const parsed = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
			const { candidateHash: _candidateHash, ...remember } = parsed;
			return remember as RememberInput;
		})(),
		attempts: Number(row.attempts),
		leaseOwner: String(row.lease_owner),
	};
}

export function claimOutboxRows(
	db: Database,
	owner: string,
	options: { now?: number; limit?: number; leaseMs?: number } = {},
): OutboxRow[] {
	ensureAgentMemoryOutboxSchema(db);
	const now = options.now ?? Date.now();
	const leaseUntil = now + (options.leaseMs ?? 30_000);
	const limit = Math.max(1, Math.min(options.limit ?? 16, 100));
	const rows: OutboxRow[] = [];
	db.transaction(() => {
		db.prepare(
			"UPDATE agentmemory_outbox SET state = 'pending', attempts = 0, lease_owner = NULL, lease_until = NULL WHERE (state = 'leased' AND lease_until <= ?) OR (state = 'failed' AND next_attempt_at <= ?)",
		).run(now, now);
		const candidates = db
			.prepare(
				"SELECT * FROM agentmemory_outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?",
			)
			.all(now, limit) as Array<Record<string, unknown>>;
		for (const candidate of candidates) {
			const result = db
				.prepare(
					"UPDATE agentmemory_outbox SET state = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending'",
				)
				.run(owner, leaseUntil, candidate.id);
			if (Number(result.changes) === 1)
				rows.push(readRow({ ...candidate, lease_owner: owner, attempts: Number(candidate.attempts) + 1 }));
		}
	})();
	return rows;
}

function claimOutboxRowsByHash(
	db: Database,
	owner: string,
	hash: string,
	options: { now?: number; leaseMs?: number } = {},
): OutboxRow[] {
	ensureAgentMemoryOutboxSchema(db);
	const now = options.now ?? Date.now();
	const leaseUntil = now + (options.leaseMs ?? 30_000);
	const rows: OutboxRow[] = [];
	db.transaction(() => {
		db.prepare(
			"UPDATE agentmemory_outbox SET state = 'pending', attempts = 0, lease_owner = NULL, lease_until = NULL WHERE (state = 'leased' AND lease_until <= ?) OR (state = 'failed' AND next_attempt_at <= ?)",
		).run(now, now);
		const candidate = db
			.prepare(
				"SELECT * FROM agentmemory_outbox WHERE candidate_hash = ? AND state = 'pending' AND next_attempt_at <= ?",
			)
			.get(hash, now) as Record<string, unknown> | undefined;
		if (!candidate) return;
		const result = db
			.prepare(
				"UPDATE agentmemory_outbox SET state = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending'",
			)
			.run(owner, leaseUntil, candidate.id);
		if (Number(result.changes) === 1)
			rows.push(readRow({ ...candidate, lease_owner: owner, attempts: Number(candidate.attempts) + 1 }));
	})();
	return rows;
}

function markDelivered(db: Database, row: OutboxRow, now: number): boolean {
	const result = db
		.prepare(
			"UPDATE agentmemory_outbox SET state = 'delivered', delivered_at = ?, lease_owner = NULL, lease_until = NULL, last_error = NULL WHERE id = ? AND state = 'leased' AND lease_owner = ?",
		)
		.run(now, row.id, row.leaseOwner);
	return Number(result.changes) === 1;
}

function markFailed(
	db: Database,
	row: OutboxRow,
	error: string,
	now: number,
	maxAttempts: number,
	backoffMs?: (attempt: number) => number,
): boolean {
	const state = row.attempts >= maxAttempts ? "failed" : "pending";
	const delay = backoffMs?.(row.attempts) ?? Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(row.attempts - 1, 0), 6));
	db.prepare(
		"UPDATE agentmemory_outbox SET state = ?, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, last_error = ? WHERE id = ? AND state = 'leased' AND lease_owner = ?",
	).run(state, now + Math.max(0, delay), error.slice(0, 500), row.id, row.leaseOwner);
	return state === "failed";
}

export type OutboxDrainResult = { delivered: number; retried: number; failed: number; skipped: number };

/** Startup recovery keeps terminal inspection rows at-least-once across restarts. */
export function recoverFailedAgentMemoryOutbox(db: Database, now = Date.now()): number {
	ensureAgentMemoryOutboxSchema(db);
	const result = db
		.prepare(
			"UPDATE agentmemory_outbox SET state = 'pending', attempts = 0, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL WHERE state = 'failed'",
		)
		.run(now);
	return Number(result.changes);
}

/** Best-effort duplicate detection using only the agentmemory public API. */
export async function publicDuplicatePreflight(client: AgentMemoryClientPort, row: OutboxRow): Promise<boolean> {
	const payload = row.payload;
	const matches = (value: unknown): boolean => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
		const item = value as Record<string, unknown>;
		const itemHash =
			typeof item.content === "string" && typeof item.project === "string"
				? rememberCandidateHash({
						content: item.content,
						project: item.project,
						...(typeof item.agentId === "string"
							? { agentId: item.agentId }
							: typeof item.agent_id === "string"
								? { agentId: item.agent_id }
								: {}),
						...(typeof item.type === "string" ? { type: item.type } : {}),
						...(Array.isArray(item.concepts)
							? { concepts: item.concepts.filter((entry): entry is string => typeof entry === "string") }
							: {}),
						...(Array.isArray(item.files)
							? { files: item.files.filter((entry): entry is string => typeof entry === "string") }
							: {}),
						...(Array.isArray(item.sourceObservationIds)
							? {
									sourceObservationIds: item.sourceObservationIds.filter(
										(entry): entry is string => typeof entry === "string",
									),
								}
							: {}),
					})
				: undefined;
		return (
			item.content === payload.content &&
			item.project === payload.project &&
			(payload.agentId === undefined || item.agentId === payload.agentId || item.agent_id === payload.agentId) &&
			(item.type === undefined || item.type === (payload.type ?? "fact")) &&
			(item.candidateHash === payloadCandidateHash ||
				item.candidate_hash === payloadCandidateHash ||
				itemHash === payloadCandidateHash)
		);
	};
	const payloadCandidateHash = rememberCandidateHash(payload);
	try {
		const page = await client.listMemories({
			project: payload.project,
			...(payload.agentId ? { agentId: payload.agentId } : {}),
			limit: 100,
		});
		if ([...(page.memories ?? []), ...(page.results ?? [])].some(matches)) return true;
	} catch {
		// Older public services may not expose listing. Search is the fallback.
	}
	try {
		const result = await client.search({
			query: payload.content,
			project: payload.project,
			...(payload.agentId ? { agentId: payload.agentId } : {}),
			limit: 20,
		});
		return [...(result.results ?? []), ...(result.memories ?? [])].some(matches);
	} catch {
		return false;
	}
}

/** Drain only after rows are committed; never holds a SQLite transaction over HTTP. */
export async function drainAgentMemoryOutbox(
	db: Database,
	client: AgentMemoryClientPort,
	options: {
		owner: string;
		now?: () => number;
		limit?: number;
		maxAttempts?: number;
		preflightDuplicate?: (row: OutboxRow) => Promise<boolean>;
		backoffMs?: (attempt: number) => number;
		candidateHash?: string;
	},
): Promise<OutboxDrainResult> {
	const now = options.now ?? Date.now;
	if (options.candidateHash) {
		const existing = db
			.prepare("SELECT state FROM agentmemory_outbox WHERE candidate_hash = ?")
			.get(options.candidateHash) as { state?: string } | undefined;
		if (existing?.state === "delivered") return { delivered: 0, retried: 0, failed: 0, skipped: 1 };
	}
	const rows = options.candidateHash
		? claimOutboxRowsByHash(db, options.owner, options.candidateHash, { now: now() })
		: claimOutboxRows(db, options.owner, { limit: options.limit, now: now() });
	const result: OutboxDrainResult = { delivered: 0, retried: 0, failed: 0, skipped: 0 };
	for (const row of rows) {
		try {
			if (options.preflightDuplicate && (await options.preflightDuplicate(row))) {
				if (markDelivered(db, row, now())) result.skipped++;
				continue;
			}
			const response = await client.remember(row.payload);
			if (response.success !== true || !response.memory?.id)
				throw new Error("remember response did not confirm persistence");
			if (markDelivered(db, row, now())) result.delivered++;
		} catch (error) {
			// Delivery is at-least-once. A transient outage must remain eligible;
			// maxAttempts is a reporting/pressure limit, not a tombstone.
			const terminal = markFailed(
				db,
				row,
				error instanceof Error ? error.message : String(error),
				now(),
				Math.max(1, Math.floor(options.maxAttempts ?? 5)),
				options.backoffMs,
			);
			if (terminal) result.failed++;
			else result.retried++;
		}
	}
	return result;
}
