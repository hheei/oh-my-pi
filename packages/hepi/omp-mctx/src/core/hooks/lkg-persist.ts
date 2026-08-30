import { sessionLog } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import type { LkgPersistenceBackend, LkgSlot } from "./lkg-slot";

export const LKG_SLOTS_DDL = `
CREATE TABLE IF NOT EXISTS lkg_slots (
	session_id TEXT PRIMARY KEY,
	json_prefix TEXT NOT NULL,
	input_id_seq TEXT NOT NULL,
	input_content_digests TEXT NOT NULL,
	input_content_signatures TEXT,
	last_input_message_id TEXT NOT NULL,
	model_key TEXT,
	provider_key TEXT,
	captured_at INTEGER NOT NULL,
	row_version INTEGER,
	capture_sequence INTEGER
);
`;

interface LkgSlotRow {
	session_id?: unknown;
	json_prefix?: unknown;
	input_id_seq?: unknown;
	input_content_digests?: unknown;
	last_input_message_id?: unknown;
	model_key?: unknown;
	provider_key?: unknown;
	captured_at?: unknown;
}

function parseStringArray(value: unknown): string[] | null {
	if (typeof value !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const result: string[] = [];
	for (const entry of parsed) {
		if (typeof entry !== "string" || entry.length === 0) return null;
		result.push(entry);
	}
	return result;
}

function parseNullableString(value: unknown): string | null | undefined {
	if (value === null || value === undefined) return null;
	return typeof value === "string" ? value : undefined;
}

export function parsePersistedLkgSlot(row: unknown): LkgSlot | undefined {
	if (!row || typeof row !== "object") return undefined;
	const record = row as LkgSlotRow;
	const jsonPrefix = record.json_prefix;
	const lastInputMessageId = record.last_input_message_id;
	const capturedAt = record.captured_at;
	const inputIdSeq = parseStringArray(record.input_id_seq);
	const inputContentDigests = parseStringArray(record.input_content_digests);
	const modelKey = parseNullableString(record.model_key);
	const providerKey = parseNullableString(record.provider_key);
	if (
		typeof jsonPrefix !== "string" ||
		typeof lastInputMessageId !== "string" ||
		lastInputMessageId.length === 0 ||
		typeof capturedAt !== "number" ||
		!Number.isFinite(capturedAt) ||
		inputIdSeq === null ||
		inputContentDigests === null ||
		inputContentDigests.length !== inputIdSeq.length ||
		modelKey === undefined ||
		providerKey === undefined
	) {
		return undefined;
	}
	return {
		jsonPrefix,
		inputIdSeq,
		inputContentDigests,
		lastInputMessageId,
		modelKey,
		providerKey,
		capturedAt,
	};
}

export function saveLkgSlotToDb(db: Database, sessionId: string, slot: LkgSlot): boolean {
	try {
		db.prepare(
			`INSERT INTO lkg_slots (
				session_id, json_prefix, input_id_seq, input_content_digests,
				last_input_message_id, model_key, provider_key, captured_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				json_prefix = excluded.json_prefix,
				input_id_seq = excluded.input_id_seq,
				input_content_digests = excluded.input_content_digests,
				last_input_message_id = excluded.last_input_message_id,
				model_key = excluded.model_key,
				provider_key = excluded.provider_key,
				captured_at = excluded.captured_at`,
		).run(
			sessionId,
			slot.jsonPrefix,
			JSON.stringify(slot.inputIdSeq),
			JSON.stringify(slot.inputContentDigests),
			slot.lastInputMessageId,
			slot.modelKey,
			slot.providerKey,
			slot.capturedAt,
		);
		return true;
	} catch (error) {
		sessionLog(sessionId, "LKG snapshot persistence failed (in-memory slot retained):", error);
		return false;
	}
}

export function clearPersistedLkgSlot(db: Database, sessionId: string): void {
	try {
		db.prepare("DELETE FROM lkg_slots WHERE session_id = ?").run(sessionId);
	} catch (error) {
		sessionLog(sessionId, "LKG snapshot durable clear failed:", error);
	}
}

export function loadPersistedLkgSlot(db: Database, sessionId: string): LkgSlot | undefined {
	let row: unknown;
	try {
		row = db.prepare("SELECT * FROM lkg_slots WHERE session_id = ?").get(sessionId);
	} catch (error) {
		sessionLog(sessionId, "LKG snapshot durable load failed:", error);
		return undefined;
	}
	if (!row) return undefined;
	const slot = parsePersistedLkgSlot(row);
	if (!slot) {
		clearPersistedLkgSlot(db, sessionId);
		return undefined;
	}
	return slot;
}

export function createDbLkgPersistence(db: Database): LkgPersistenceBackend {
	return {
		load: (sessionId) => loadPersistedLkgSlot(db, sessionId),
		clear: (sessionId) => clearPersistedLkgSlot(db, sessionId),
	};
}
