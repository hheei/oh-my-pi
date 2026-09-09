import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { PREVIEW_LIMITS, shortenPath, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import type { Database } from "../core/shared/sqlite";
import type { AgentMemoryClientPort } from "./client";
import { sanitizeDiagnosticText } from "../core/shared/redaction";
import { loadAgentMemorySettings, type AgentMemoryBridgeSettings } from "./config";
import { formatRecallPresentationLines } from "./recall-presentation";
import { listActiveBranchRecallEvents } from "./recall-ledger";

export type AgentMemoryObservedAvailability = "unknown" | "healthy" | "degraded";

export interface AgentMemoryObservedRuntimeState {
	availability: AgentMemoryObservedAvailability;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	lastResult: "success" | "failure" | null;
	lastOperation: string | null;
	lastError: string | null;
}

export interface AgentMemoryRecallPreview {
	eventId: string;
	sourceKinds: string[];
	presentationState: "pending" | "claimed" | "presented";
	preview: string;
}

export interface AgentMemoryStatus {
	bridgeState: "disabled" | AgentMemoryObservedAvailability;
	gates: {
		bridge: boolean;
		capture: boolean;
		inject: boolean;
		historianRetrieval: boolean;
		memoryTools: boolean;
	};
	observed: AgentMemoryObservedRuntimeState;
	recallCount: number;
	sourceKindCounts: Record<string, number>;
	presentationCounts: Record<"pending" | "claimed" | "presented", number>;
	recallPreviews: AgentMemoryRecallPreview[];
	outbox: {
		pending: number;
		leased: number;
		failed: number;
		oldestPendingAgeMs: number | null;
		nextRetryAt: number | null;
		latestError: string | null;
	};
}

const PREVIEW_EVENTS = Math.max(1, PREVIEW_LIMITS.EXPANDED_LINES);
const SAFE_ERROR_WIDTH = PREVIEW_LIMITS.OUTPUT_EXPANDED * TRUNCATE_LENGTHS.LONG;
let observed: AgentMemoryObservedRuntimeState = {
	availability: "unknown",
	lastSuccessAt: null,
	lastFailureAt: null,
	lastOperation: null,
	lastResult: null,
	lastError: null,
};

function safeText(value: string): string {
	return truncateToWidth(replaceTabs(shortenPath(sanitizeDiagnosticText(value))), SAFE_ERROR_WIDTH);
}

/** Records the latest bridge outcome; status rendering only reads this local state. */
export function recordAgentMemoryOperation(operation: string, result: "success" | "failure", error?: unknown): void {
	const now = Date.now();
	if (result === "success") {
		observed = {
			...observed,
			availability: "healthy",
			lastSuccessAt: now,
			lastOperation: safeText(operation),
			lastResult: "success",
			lastError: null,
		};
		return;
	}
	observed = {
		...observed,
		availability: "degraded",
		lastFailureAt: now,
		lastOperation: safeText(operation),
		lastResult: "failure",
		lastError: safeText(error instanceof Error ? error.message : String(error ?? "request failed")),
	};
}

/** Isolated for tests and runtime reloads; no persistence or probing is involved. */
export function resetAgentMemoryObservedRuntimeState(): void {
	observed = {
		availability: "unknown",
		lastSuccessAt: null,
		lastFailureAt: null,
		lastOperation: null,
		lastResult: null,
		lastError: null,
	};
}

export function readAgentMemoryObservedRuntimeState(): AgentMemoryObservedRuntimeState {
	return { ...observed };
}

/** Decorates the existing bridge client so normal operations update the shared observed state. */
export function observeAgentMemoryClient(client: AgentMemoryClientPort): AgentMemoryClientPort {
	return new Proxy(client, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function" || typeof property !== "string") return value;
			return async (...args: unknown[]) => {
				try {
					const result = await value.apply(target, args);
					recordAgentMemoryOperation(property, "success");
					return result;
				} catch (error) {
					recordAgentMemoryOperation(property, "failure", error);
					throw error;
				}
			};
		},
	}) as AgentMemoryClientPort;
}

/** Reads local ledger/outbox facts only; this never contacts AgentMemory. */
export function readAgentMemoryStatus(
	db: Database,
	sessionId: string,
	branchId = "main",
	settings: AgentMemoryBridgeSettings = loadAgentMemorySettings(),
	now = Date.now(),
): AgentMemoryStatus {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('mctx_recall_events', 'agentmemory_outbox')")
		.all() as Array<{ name: unknown }>;
	const tableNames = new Set(tables.map(table => String(table.name)));
	const events = tableNames.has("mctx_recall_events")
		? listActiveBranchRecallEvents(db, sessionId, branchId)
		: [];
	const hasOutbox = tableNames.has("agentmemory_outbox");
	const gates = {
		bridge: settings.enabled,
		capture: settings.enabled && settings.capture,
		inject: settings.enabled && settings.inject,
		historianRetrieval: settings.enabled && settings.historianRetrieval,
		memoryTools: settings.enabled && settings.memoryTools,
	};
	const sourceKindCounts: Record<string, number> = {};
	const presentationCounts: AgentMemoryStatus["presentationCounts"] = { pending: 0, claimed: 0, presented: 0 };
	for (const event of events) {
		presentationCounts[event.presentationState]++;
		for (const source of event.sources) {
			const sourceKind = safeText(source.sourceKind);
			sourceKindCounts[sourceKind] = (sourceKindCounts[sourceKind] ?? 0) + 1;
		}
	}
	const outboxRows = hasOutbox
		? (db
			.prepare("SELECT state, created_at, next_attempt_at, last_error, id FROM agentmemory_outbox")
			.all() as Array<{
				state: unknown;
				created_at: unknown;
				next_attempt_at: unknown;
				last_error: unknown;
				id: unknown;
			}>)
		: [];
	let pending = 0;
	let leased = 0;
	let failed = 0;
	let oldestPendingAt: number | null = null;
	let nextRetryAt: number | null = null;
	let latestError: { id: number; text: string } | null = null;
	for (const row of outboxRows) {
		const state = String(row.state);
		const createdAt = Number(row.created_at);
		const nextAttemptAt = Number(row.next_attempt_at);
		if (state === "pending") {
			pending++;
			if (Number.isFinite(createdAt) && (oldestPendingAt === null || createdAt < oldestPendingAt)) oldestPendingAt = createdAt;
		}
		if (state === "leased") leased++;
		if (state === "failed") failed++;
		if ((state === "pending" || state === "failed") && Number.isFinite(nextAttemptAt) && (nextRetryAt === null || nextAttemptAt < nextRetryAt)) nextRetryAt = nextAttemptAt;
		if (typeof row.last_error === "string" && row.last_error.trim()) {
			const candidate = { id: Number(row.id), text: safeText(row.last_error) };
			if (!latestError || candidate.id > latestError.id) latestError = candidate;
		}
	}
	return {
		bridgeState: settings.enabled ? observed.availability : "disabled",
		gates,
		observed: readAgentMemoryObservedRuntimeState(),
		recallCount: events.length,
		sourceKindCounts,
		presentationCounts,
		recallPreviews: events.slice(-PREVIEW_EVENTS).map(event => ({
			eventId: safeText(event.eventId),
			sourceKinds: [...new Set(event.sources.map(source => safeText(source.sourceKind)))].sort(),
			presentationState: event.presentationState,
			preview: safeText(formatRecallPresentationLines(event).join(" ")),
		})),
		outbox: {
			pending,
			leased,
			failed,
			oldestPendingAgeMs: oldestPendingAt === null ? null : Math.max(0, now - oldestPendingAt),
			nextRetryAt,
			latestError: latestError?.text ?? null,
		},
	};
}
