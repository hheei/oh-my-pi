import * as crypto from "node:crypto";
import {
	declarePreUpgradeEpoch,
	gcUnreachableRecall,
	listActiveBranchRecallEvents,
	recordProjectionEpoch,
	type RecallEvent,
} from "../../agentmemory/recall-ledger";
import {
	appendContextProjection,
	bootstrapContextProjection,
	deriveContextContractDigest,
	readContextProjection,
	readLastKnownGoodContextProjection,
	transitionContextProjection,
	type ContextProjectionRecord,
} from "./context-projection";
import { stableStringify } from "../shared/stable-json";
import type { Database } from "../shared/sqlite";

export const CONTEXT_PROJECTION_RENDERER_VERSION = "mctx-context-projection/1";

type ProjectionMessage = {
	id?: string;
	role?: string;
	content?: unknown;
};

export type ContextProjectionPublishInput = {
	sessionId: string;
	branchId?: string;
	messages: readonly ProjectionMessage[];
	contract: {
		modelDigest: string;
		systemDigest: string;
		toolsDigest: string;
	};
	reason?: string;
	earliestChangedRegion?: string;
	withdrawsRecovery?: boolean;
	createdAt?: number;
};

export type ContextProjectionPublishAction =
	| "unchanged"
	| "bootstrap"
	| "append"
	| "transition"
	| "reused_lkg"
	| "withdrawn";

export type ContextProjectionPublishResult = {
	action: ContextProjectionPublishAction;
	record: ContextProjectionRecord | undefined;
};

type PendingTransition = {
	reason: string;
	earliestChangedRegion?: string;
};

type RenderedEntry = {
	id?: string;
	line: string;
};

const pendingTransitions = new Map<string, PendingTransition>();
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function pendingKey(sessionId: string): string {
	return sessionId;
}

function sha256(value: Uint8Array): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function frame(value: string): Uint8Array {
	return encoder.encode(`${encoder.encode(value).byteLength}:${value}`);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const length = parts.reduce((total, part) => total + part.byteLength, 0);
	const output = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function deriveEpochId(
	sessionId: string,
	branchId: string,
	parentEpochId: string,
	reason: string,
	snapshotDigest: string,
	contractDigest: string,
): string {
	return `projection-epoch-${sha256(
		concat([sessionId, branchId, parentEpochId, reason, snapshotDigest, contractDigest].map(frame)),
	)}`;
}

function bytePrefix(prefix: Uint8Array, body: Uint8Array): boolean {
	return prefix.byteLength < body.byteLength && prefix.every((value, index) => value === body[index]);
}

function recallContent(event: RecallEvent): string {
	try {
		const text = decoder.decode(event.body);
		if (encoder.encode(text).every((value, index) => value === event.body[index])) return text;
	} catch {
		// Non-UTF-8 recall bytes are preserved below as an explicit base64 value.
	}
	return `base64:${Buffer.from(event.body).toString("base64")}`;
}

function renderEntries(messages: readonly ProjectionMessage[], recalls: readonly RecallEvent[]): RenderedEntry[] {
	const messageIds = new Set(messages.map(message => message.id).filter((id): id is string => id !== undefined));
	const byAnchor = new Map<string, RecallEvent[]>();
	for (const recall of recalls) {
		if (messageIds.has(recall.eventId)) continue;
		const anchored = byAnchor.get(recall.userEntryAnchor);
		if (anchored) anchored.push(recall);
		else byAnchor.set(recall.userEntryAnchor, [recall]);
	}
	const entries: RenderedEntry[] = [];
	for (const message of messages) {
		entries.push({
			id: message.id,
			line: stableStringify({ id: message.id, role: message.role, content: message.content }),
		});
		if (message.id === undefined) continue;
		const anchored = byAnchor.get(message.id);
		if (!anchored) continue;
		for (const recall of anchored) {
			entries.push({
				id: recall.eventId,
				line: stableStringify({ id: recall.eventId, role: "recall", content: recallContent(recall) }),
			});
		}
		byAnchor.delete(message.id);
	}
	for (const recall of recalls) {
		if (!byAnchor.has(recall.userEntryAnchor)) continue;
		entries.push({
			id: recall.eventId,
			line: stableStringify({ id: recall.eventId, role: "recall", content: recallContent(recall) }),
		});
	}
	return entries;
}

function appendEventId(entries: readonly RenderedEntry[], priorBody: Uint8Array, body: Uint8Array): string {
	const priorLines = priorBody.byteLength === 0 ? 0 : new TextDecoder().decode(priorBody).split("\n").length;
	const added = entries.slice(priorLines);
	const last = added.at(-1)?.id;
	if (last && entries.filter(entry => entry.id === last).length === 1) return last;
	return `append-${sha256(body.slice(priorBody.byteLength))}`;
}

export function notePendingProjectionTransition(
	sessionId: string,
	reason: string,
	earliestChangedRegion?: string,
): void {
	pendingTransitions.set(pendingKey(sessionId), {
		reason,
		...(earliestChangedRegion === undefined ? {} : { earliestChangedRegion }),
	});
}

/** Publishes the provider-facing JSONL projection and records its immutable epoch. */
export function publishContextProjection(
	db: Database,
	input: ContextProjectionPublishInput,
): ContextProjectionPublishResult {
	const branchId = input.branchId ?? "main";
	const recalls = listActiveBranchRecallEvents(db, input.sessionId, branchId);
	const entries = renderEntries(input.messages, recalls);
	const body = encoder.encode(entries.map(entry => entry.line).join("\n"));
	const snapshotDigest = sha256(body);
	const contractDigest = deriveContextContractDigest({
		rendererVersion: CONTEXT_PROJECTION_RENDERER_VERSION,
		...input.contract,
	});
	const ledger = declarePreUpgradeEpoch(db, {
		sessionId: input.sessionId,
		branchId,
		rendererVersion: CONTEXT_PROJECTION_RENDERER_VERSION,
		contractDigest,
		snapshotDigest,
		...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
	});
	const current = readContextProjection(db, input.sessionId, branchId);
	const pending = pendingTransitions.get(pendingKey(input.sessionId));
	const consumePending = () => {
		pendingTransitions.delete(pendingKey(input.sessionId));
	};
	if (!current) {
		consumePending();
		if (input.withdrawsRecovery) return { action: "withdrawn", record: undefined };
		const record = bootstrapContextProjection(db, {
			sessionId: input.sessionId,
			branchId,
			epochId: ledger.epochId,
			rendererVersion: CONTEXT_PROJECTION_RENDERER_VERSION,
			contractDigest,
			baseline: body,
			...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
		});
		return { action: "bootstrap", record };
	}

	if (!input.withdrawsRecovery && current.bodyDigest === snapshotDigest && current.contractDigest === contractDigest) {
		consumePending();
		return { action: "unchanged", record: current };
	}
	if (!input.withdrawsRecovery && current.contractDigest === contractDigest && bytePrefix(current.body, body)) {
		consumePending();
		const record = appendContextProjection(db, {
			sessionId: input.sessionId,
			branchId,
			epochId: current.epochId,
			eventId: appendEventId(entries, current.body, body),
			body: body.slice(current.body.byteLength),
			...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
		});
		return { action: "append", record };
	}

	const reason = input.withdrawsRecovery
		? "privacy_withdrawal"
		: (input.reason ??
			pending?.reason ??
			(current.contractDigest !== contractDigest ? "renderer_contract" : "history_refresh"));
	const earliestChangedRegion = input.earliestChangedRegion ?? pending?.earliestChangedRegion;
	const epochId = deriveEpochId(input.sessionId, branchId, current.epochId, reason, snapshotDigest, contractDigest);
	recordProjectionEpoch(db, {
		epochId,
		sessionId: input.sessionId,
		branchId,
		parentEpochId: current.epochId,
		reason,
		rendererVersion: CONTEXT_PROJECTION_RENDERER_VERSION,
		...(earliestChangedRegion === undefined ? {} : { earliestChangedRegion }),
		contractDigest,
		snapshotDigest,
		reachableEpochs: [],
		...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
	});
	const record = transitionContextProjection(db, {
		sessionId: input.sessionId,
		branchId,
		epochId,
		rendererVersion: CONTEXT_PROJECTION_RENDERER_VERSION,
		contractDigest,
		fromEpochId: current.epochId,
		baseline: body,
		reason,
		...(earliestChangedRegion === undefined ? {} : { earliestChangedRegion }),
		...(input.withdrawsRecovery ? { withdrawsRecovery: true } : {}),
		...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
	});
	consumePending();
	return {
		action: input.withdrawsRecovery ? "withdrawn" : "transition",
		record: input.withdrawsRecovery ? undefined : record,
	};
}

/** Attempts publication without exposing a withdrawn snapshot as recovery state. */
export function tryPublishContextProjection(
	db: Database,
	input: ContextProjectionPublishInput,
): ContextProjectionPublishResult {
	try {
		return publishContextProjection(db, input);
	} catch {
		const record = readLastKnownGoodContextProjection(db, input.sessionId, input.branchId ?? "main");
		return record ? { action: "reused_lkg", record } : { action: "withdrawn", record: undefined };
	}
}

/** Withdraws a projection from recovery, then reclaims recall no longer reachable from any head. */
export function withdrawProjectionPrivacy(
	db: Database,
	input: ContextProjectionPublishInput,
): ContextProjectionPublishResult & { deletedEvents: number } {
	const result = publishContextProjection(db, {
		...input,
		withdrawsRecovery: true,
		reason: "privacy_withdrawal",
	});
	return { ...result, ...gcUnreachableRecall(db) };
}
