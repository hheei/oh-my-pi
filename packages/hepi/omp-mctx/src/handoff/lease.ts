import type { Database } from "#core/shared/sqlite";

export const HANDOFF_LEASE_TTL_MS = 5 * 60 * 1000;
export const HANDOFF_LEASE_RENEWAL_MS = 60 * 1000;

export interface HandoffLease {
	readonly sessionId: string;
	readonly holderId: string;
	readonly requestId: string;
	readonly stage: string;
	readonly acquiredAt: number;
	readonly expiresAt: number;
}

export function ensureHandoffLeaseTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS handoff_lease (
			session_id TEXT PRIMARY KEY,
			holder_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			stage TEXT NOT NULL,
			acquired_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`);
}

export function acquireHandoffLease(
	db: Database,
	sessionId: string,
	holderId: string,
	requestId: string,
	stage: string,
	now = Date.now(),
): HandoffLease | null {
	ensureHandoffLeaseTable(db);
	const expiresAt = now + HANDOFF_LEASE_TTL_MS;
	const result = db
		.prepare(
			`INSERT INTO handoff_lease (session_id, holder_id, request_id, stage, acquired_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET
				holder_id = excluded.holder_id,
				request_id = excluded.request_id,
				stage = excluded.stage,
				acquired_at = excluded.acquired_at,
				expires_at = excluded.expires_at
			 WHERE handoff_lease.holder_id = excluded.holder_id
				OR handoff_lease.expires_at <= ?`,
		)
		.run(sessionId, holderId, requestId, stage, now, expiresAt, now);
	if (result.changes !== 1) return null;
	return { sessionId, holderId, requestId, stage, acquiredAt: now, expiresAt };
}

export function renewHandoffLease(
	db: Database,
	sessionId: string,
	holderId: string,
	stage: string,
	now = Date.now(),
): boolean {
	ensureHandoffLeaseTable(db);
	const expiresAt = now + HANDOFF_LEASE_TTL_MS;
	const result = db
		.prepare(
			`UPDATE handoff_lease
			 SET expires_at = ?, acquired_at = ?, stage = ?
			 WHERE session_id = ? AND holder_id = ? AND expires_at > ?`,
		)
		.run(expiresAt, now, stage, sessionId, holderId, now);
	return result.changes === 1;
}

export function releaseHandoffLease(db: Database, sessionId: string, holderId: string): void {
	ensureHandoffLeaseTable(db);
	db.prepare("DELETE FROM handoff_lease WHERE session_id = ? AND holder_id = ?").run(
		sessionId,
		holderId,
	);
}

export function getHandoffLease(
	db: Database,
	sessionId: string,
	now = Date.now(),
): HandoffLease | null {
	ensureHandoffLeaseTable(db);
	const row = db
		.prepare(
			`SELECT session_id, holder_id, request_id, stage, acquired_at, expires_at
			 FROM handoff_lease
			 WHERE session_id = ? AND expires_at > ?`,
		)
		.get(sessionId, now) as
		| {
				session_id: string;
				holder_id: string;
				request_id: string;
				stage: string;
				acquired_at: number;
				expires_at: number;
		  }
		| undefined;
	if (!row) return null;
	return {
		sessionId: row.session_id,
		holderId: row.holder_id,
		requestId: row.request_id,
		stage: row.stage,
		acquiredAt: row.acquired_at,
		expiresAt: row.expires_at,
	};
}
