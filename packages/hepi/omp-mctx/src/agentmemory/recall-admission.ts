import * as crypto from "node:crypto";
import type { Database } from "../core/shared/sqlite";
import type { AgentMemoryClientPort } from "./client";
import {
	admitRecallEvent,
	declarePreUpgradeEpoch,
	listActiveBranchRecallEvents,
	type RecallEvent,
} from "./recall-ledger";
import {
	passesMemorySearchScope,
	unifiedMemorySearch,
	type MemorySearchRemoteCandidate,
	type MemorySearchScope,
} from "./memory-search";
import { markTurnTainted, type TurnTaintStore } from "./inject-save";

export type RecallAdmissionMessage = { id?: string; role?: string; content?: unknown };

export type RecallAdmissionInput = {
	db: Database;
	sessionId: string;
	branchId?: string;
	messages: readonly RecallAdmissionMessage[];
	userEntryAnchor: string;
	query: string;
	scope: MemorySearchScope;
	client: AgentMemoryClientPort;
	signal?: AbortSignal;
	rendererVersion?: string;
	contractDigest?: string;
	snapshotDigest?: string;
	taint?: TurnTaintStore;
};

export type RecallAdmissionResult = {
	status: "admitted" | "reused" | "skipped" | "failed";
	event?: RecallEvent;
	reason?: string;
};

type RecallGenerationBinding = {
	generation: number;
	branchId: string;
	userEntryAnchor: string;
	epochId: string;
	scopeKey: string;
	controller: AbortController;
};

const generations = new Map<string, number>();
const bindings = new Map<string, RecallGenerationBinding>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function scopeKey(scope: MemorySearchScope): string {
	return `${scope.project}\u0000${scope.agentId ?? ""}\u0000${scope.activeSessionId ?? ""}`;
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(contentText).join("");
	if (!value || typeof value !== "object") return "";
	const record = value as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	if (typeof record.content === "string") return record.content;
	return "";
}

function isCurrent(sessionId: string, binding: RecallGenerationBinding): boolean {
	const current = bindings.get(sessionId);
	return (
		current !== undefined &&
		current.generation === binding.generation &&
		current.branchId === binding.branchId &&
		current.userEntryAnchor === binding.userEntryAnchor &&
		current.epochId === binding.epochId &&
		current.scopeKey === binding.scopeKey
	);
}

function candidateComparator(left: MemorySearchRemoteCandidate, right: MemorySearchRemoteCandidate): number {
	return (
		compareText(left.kind, right.kind) || compareText(left.id, right.id) || compareText(left.content, right.content)
	);
}

function digest(content: string): string {
	return crypto.createHash("sha256").update(encoder.encode(content)).digest("hex");
}

/** Advance the process-local recall generation for a session. */
export function nextRecallGeneration(sessionId: string): number {
	const generation = (generations.get(sessionId) ?? 0) + 1;
	generations.set(sessionId, generation);
	return generation;
}

/** Return the process-local recall generation for a session, or zero before admission. */
export function currentRecallGeneration(sessionId: string): number {
	return generations.get(sessionId) ?? 0;
}

/** Extract visible text from a Pi message content value. */
export function extractMessageText(content: unknown): string {
	return contentText(content);
}

/** Find the latest user message with non-empty visible text. */
export function findLatestUserMessage(
	messages: readonly RecallAdmissionMessage[],
): { index: number; id: string; text: string } | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		const text = extractMessageText(message.content);
		if (message.role === "user" && message.id && text) return { index, id: message.id, text };
	}
	return undefined;
}

/** True when a candidate's visible content is already included in the current window. */
export function windowAlreadyContains(messages: readonly RecallAdmissionMessage[], content: string): boolean {
	const trimmed = content.trim();
	if (!trimmed) return false;
	return messages
		.map(message => extractMessageText(message.content))
		.join("\n")
		.includes(trimmed);
}

/** Render deterministic, model-visible automatic recall text. */
export function renderAutomaticRecallBody(candidates: readonly MemorySearchRemoteCandidate[]): Uint8Array {
	const ordered = [...candidates].sort(candidateComparator);
	return encoder.encode(
		ordered.map(candidate => `[${candidate.kind}:${candidate.id}] ${candidate.content.trim()}`).join("\n"),
	);
}

/** Search, scope-gate, and atomically admit recall attached to a stable user-entry anchor. */
export async function admitAutomaticRecall(input: RecallAdmissionInput): Promise<RecallAdmissionResult> {
	if (!input.userEntryAnchor) return { status: "skipped", reason: "no-anchor" };
	if (!input.messages.some(message => message.id === input.userEntryAnchor && message.role === "user")) {
		return { status: "skipped", reason: "no-user-entry" };
	}
	const branchId = input.branchId ?? "main";
	const rendererVersion = input.rendererVersion ?? "mctx-context-projection/1";
	const contractDigest = input.contractDigest ?? "admission";
	const snapshotDigest = input.snapshotDigest ?? "admission";
	try {
		const epoch = declarePreUpgradeEpoch(input.db, {
			sessionId: input.sessionId,
			branchId,
			rendererVersion,
			contractDigest,
			snapshotDigest,
		});
		const existing = listActiveBranchRecallEvents(input.db, input.sessionId, branchId).find(
			event => event.userEntryAnchor === input.userEntryAnchor && event.epochId === epoch.epochId,
		);
		if (existing) {
			if (input.taint) markTurnTainted(input.taint, existing.eventId, "automatic-recall", existing.eventId);
			return { status: "reused", event: existing };
		}

		const generation = nextRecallGeneration(input.sessionId);
		const controller = new AbortController();
		const prior = bindings.get(input.sessionId);
		prior?.controller.abort();
		const binding: RecallGenerationBinding = {
			generation,
			branchId,
			userEntryAnchor: input.userEntryAnchor,
			epochId: epoch.epochId,
			scopeKey: scopeKey(input.scope),
			controller,
		};
		bindings.set(input.sessionId, binding);
		const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
		const search = await unifiedMemorySearch(() => Promise.resolve([]), input.client, input.scope, input.query, {
			signal,
		});
		if (!isCurrent(input.sessionId, binding) || currentRecallGeneration(input.sessionId) !== generation) {
			return { status: "skipped", reason: "stale" };
		}
		const eligible = search.remote
			.filter(candidate => passesMemorySearchScope(candidate, input.scope))
			.filter(candidate => candidate.content.trim())
			.sort(candidateComparator);
		if (eligible.length === 0) {
			if (search.partial.length > 0) return { status: "failed", reason: search.partial.join("; ") };
			return { status: "skipped", reason: "empty-results" };
		}
		const candidates = eligible.filter(candidate => !windowAlreadyContains(input.messages, candidate.content));
		if (candidates.length === 0) return { status: "skipped", reason: "already-visible" };
		const body = renderAutomaticRecallBody(candidates);
		const event = admitRecallEvent(input.db, {
			sessionId: input.sessionId,
			branchId,
			userEntryAnchor: input.userEntryAnchor,
			epochId: epoch.epochId,
			body,
			origin: "direct_retrieval",
			promotionEligibility: "requires_independent_evidence",
			sources: candidates.map(candidate => ({
				sourceId: candidate.id,
				sourceKind: candidate.kind,
				contentDigest: digest(candidate.content),
				project: input.scope.project,
				remoteId: candidate.id,
				...(input.scope.agentId === undefined ? {} : { agentScope: input.scope.agentId }),
				scope: {
					project: input.scope.project,
					...(input.scope.agentId === undefined ? {} : { agentId: input.scope.agentId }),
					...(input.scope.activeSessionId === undefined ? {} : { activeSessionId: input.scope.activeSessionId }),
				},
			})),
			dependencies: [{ dependencyId: input.userEntryAnchor, dependencyKind: "user_entry" }],
		});
		if (input.taint) markTurnTainted(input.taint, event.eventId, "automatic-recall", event.eventId);
		return { status: "admitted", event };
	} catch (error: unknown) {
		return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}

/** Insert an admitted recall event immediately after its anchor without changing the input array. */
export function applyAdmittedRecallToMessages<T extends RecallAdmissionMessage>(
	messages: readonly T[],
	event: RecallEvent,
): Array<T | RecallAdmissionMessage> {
	if (messages.some(message => message.id === event.eventId)) return [...messages];
	const index = messages.findIndex(message => message.id === event.userEntryAnchor);
	if (index < 0) return [...messages];
	return [
		...messages.slice(0, index + 1),
		{ id: event.eventId, role: "user", content: decoder.decode(event.body) },
		...messages.slice(index + 1),
	];
}
