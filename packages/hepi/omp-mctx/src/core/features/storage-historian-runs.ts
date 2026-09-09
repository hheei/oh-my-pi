import type { Database } from "../shared/sqlite";
import { hasSqliteTable } from "../shared/sqlite-helpers";

/**
 * Per historian-invocation telemetry.
 *
 * One row per attempted historian run (incremental publish, recomp pass, or
 * session-upgrade), recording the INPUT (chunk range) and OUTPUT shape
 * (compartments / facts / events / importance) plus success/failure. Tokens and
 * the model used live on the FK-linked `subagent_invocations` row
 * (`subagentInvocationId`) — join to get cost/model.
 *
 * Purpose: debugging (which range produced what), quality analysis (facts per
 * output token, importance distribution by model), and the productization /
 * training-data roadmap.
 */

export type HistorianRunStatus =
	/** Compartments were validated + published. */
	| "success"
	/** A real failure (validation / coverage / no-progress / exception). */
	| "failed"
	/** A successful no-op (nothing eligible to compact, empty chunk). */
	| "noop";

export type HistorianRunKind = "incremental" | "recomp" | "partial-recomp" | "upgrade";

export interface HistorianRunInput {
	sessionId: string;
	harness: string;
	/** FK to subagent_invocations.id (tokens/model/timing). NULL if no invocation. */
	subagentInvocationId?: number | null | undefined;
	runKind: HistorianRunKind;
	status: HistorianRunStatus;
	/** Failure reason for `failed` (and optionally a no-op explanation). */
	failureReason?: string | null | undefined;
	/** Raw-ordinal range of the input chunk. */
	chunkStartOrdinal?: number | null | undefined;
	chunkEndOrdinal?: number | null | undefined;
	/** Historian's reported next-start (its `<unprocessed_from>`). */
	unprocessedFrom?: number | null | undefined;
	/** Compartments actually persisted (post discard-last). */
	compartmentsProduced?: number | undefined;
	/** Durable id range of the persisted compartments. */
	compartmentIdMin?: number | null | undefined;
	compartmentIdMax?: number | null | undefined;
	/** Facts emitted in the `<facts>` block. */
	factsEmitted?: number | undefined;
	/** `{ [category]: count }` of emitted facts. */
	factsByCategory?: Record<string, number> | null | undefined;
	/** Events emitted (causal_incident / trajectory_correction). */
	eventsEmitted?: number | undefined;
	/** Importance distribution across persisted compartments. */
	importanceMin?: number | null | undefined;
	importanceMax?: number | null | undefined;
	importanceAvg?: number | null | undefined;
	/** Whether the lookahead-free last compartment was discarded (boundary healing). */
	discardedLast?: boolean | undefined;
	/** Whether the run produced/processed legacy (pre-v2) compartments. */
	legacy?: boolean | undefined;
}

/**
 * Record one historian run. Best-effort: never throws into the historian path —
 * telemetry must not break compaction. Returns the new row id, or null on
 * failure.
 */
export function recordHistorianRun(db: Database, input: HistorianRunInput): number | null {
	try {
		const result = db
			.prepare(
				`INSERT INTO historian_runs (
                    session_id, harness, subagent_invocation_id, run_kind, status,
                    failure_reason, chunk_start_ordinal, chunk_end_ordinal, unprocessed_from,
                    compartments_produced, compartment_id_min, compartment_id_max,
                    facts_emitted, facts_by_category_json, events_emitted,
                    importance_min, importance_max, importance_avg,
                    discarded_last, legacy, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.sessionId,
				input.harness,
				input.subagentInvocationId ?? null,
				input.runKind,
				input.status,
				input.failureReason ?? null,
				input.chunkStartOrdinal ?? null,
				input.chunkEndOrdinal ?? null,
				input.unprocessedFrom ?? null,
				input.compartmentsProduced ?? 0,
				input.compartmentIdMin ?? null,
				input.compartmentIdMax ?? null,
				input.factsEmitted ?? 0,
				input.factsByCategory ? JSON.stringify(input.factsByCategory) : null,
				input.eventsEmitted ?? 0,
				input.importanceMin ?? null,
				input.importanceMax ?? null,
				input.importanceAvg ?? null,
				input.discardedLast ? 1 : 0,
				input.legacy ? 1 : 0,
				Date.now(),
			);
		return Number(result.lastInsertRowid);
	} catch {
		return null;
	}
}

/** The compact successful-run facts suitable for status surfaces. */
export interface HistorianRunSummary {
	id: number;
	runKind: HistorianRunKind;
	createdAt: number;
	compartmentsProduced: number;
	factsEmitted: number;
	eventsEmitted: number;
}

/**
 * Read the latest meaningful successful run without joining invocation data.
 * `noop` rows are intentionally excluded: they describe an attempted pass, not
 * a useful historian outcome. Telemetry is optional on older databases, so a
 * missing table, malformed row, or query failure is represented as `null`.
 */
export function getLatestMeaningfulHistorianRun(
	db: Database,
	sessionId: string,
): HistorianRunSummary | null {
	try {
		if (!hasSqliteTable(db, "historian_runs")) return null;
		const row = db
			.prepare<
				[string],
				{
					id: number;
					run_kind: HistorianRunKind;
					created_at: number;
					compartments_produced: number;
					facts_emitted: number;
					events_emitted: number;
				}
			>(
				`SELECT id, run_kind, created_at, compartments_produced, facts_emitted, events_emitted
				 FROM historian_runs
				 WHERE session_id = ? AND status = 'success'
				 ORDER BY created_at DESC, id DESC
				 LIMIT 1`,
			)
			.get(sessionId);
		if (!row || typeof row.id !== "number" || typeof row.created_at !== "number") return null;
		if (
			(row.run_kind !== "incremental" &&
				row.run_kind !== "recomp" &&
				row.run_kind !== "partial-recomp" &&
				row.run_kind !== "upgrade") ||
			!Number.isFinite(row.created_at) ||
			!Number.isFinite(row.id)
		) {
			return null;
		}
		const compartmentsProduced = Number(row.compartments_produced ?? 0);
		const factsEmitted = Number(row.facts_emitted ?? 0);
		const eventsEmitted = Number(row.events_emitted ?? 0);
		if (![compartmentsProduced, factsEmitted, eventsEmitted].every(Number.isFinite)) return null;
		return {
			id: row.id,
			runKind: row.run_kind,
			createdAt: row.created_at,
			compartmentsProduced,
			factsEmitted,
			eventsEmitted,
		};
	} catch {
		return null;
	}
}

/** Alias named for callers that only need the successful-run distinction. */
export const getLatestSuccessfulHistorianRun = getLatestMeaningfulHistorianRun;

/** Summarize a list of importance values into min/max/avg (null on empty). */
export function summarizeImportance(values: readonly number[]): {
	min: number | null;
	max: number | null;
	avg: number | null;
} {
	const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
	const first = nums[0];
	if (first === undefined) return { min: null, max: null, avg: null };
	let min = first;
	let max = first;
	let sum = 0;
	for (const v of nums) {
		if (v < min) min = v;
		if (v > max) max = v;
		sum += v;
	}
	return { min, max, avg: sum / nums.length };
}

/** Tally facts by their category for `factsByCategory`. */
export function tallyFactsByCategory(
	facts: ReadonlyArray<{ category?: string | null }>,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const f of facts) {
		const cat = (f.category ?? "UNKNOWN").trim() || "UNKNOWN";
		out[cat] = (out[cat] ?? 0) + 1;
	}
	return out;
}
