import { readFileSync } from "node:fs";
import type { HandoffAttemptRecord, HandoffContextDetails, HandoffRequestRecord } from "./model";
import {
	HANDOFF_ATTEMPT_TYPE,
	HANDOFF_CONTEXT_TYPE,
	HANDOFF_REQUEST_TYPE,
	isHandoffProgressPhase,
	isHandoffTerminalPhase,
	reduceHandoffPhase,
} from "./model";

export interface ParsedHandoffSession {
	readonly requests: HandoffRequestRecord[];
	readonly attempts: HandoffAttemptRecord[];
	readonly contexts: Array<{
		readonly requestId: string;
		readonly details: HandoffContextDetails;
		readonly xml: string;
	}>;
}

export function parseHandoffEntries(entries: readonly unknown[]): ParsedHandoffSession {
	const requests: HandoffRequestRecord[] = [];
	const attempts: HandoffAttemptRecord[] = [];
	const contexts: ParsedHandoffSession["contexts"] = [];
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		const row = entry as {
			type?: unknown | undefined;
			customType?: unknown | undefined;
			data?: unknown | undefined;
			details?: unknown | undefined;
			content?: unknown | undefined;
		};
		if (row.customType === HANDOFF_REQUEST_TYPE) {
			const record = asRequest(row.data ?? row.details);
			if (record) requests.push(record);
			continue;
		}
		if (row.customType === HANDOFF_ATTEMPT_TYPE) {
			const record = asAttempt(row.data ?? row.details);
			if (record) attempts.push(record);
			continue;
		}
		if (row.customType === HANDOFF_CONTEXT_TYPE) {
			const details = asContextDetails(row.details);
			const xml = extractXml(row.content);
			if (details && xml) {
				contexts.push({ requestId: details.requestId, details, xml });
			}
		}
	}
	return { requests, attempts, contexts };
}

export function parseSessionFileEntries(sessionFile: string): unknown[] {
	const text = readFileSync(sessionFile, "utf8");
	const entries: unknown[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Skip corrupt lines; discovery fails closed later if hashes collide.
		}
	}
	return entries;
}

export function parseHandoffSessionFile(sessionFile: string): ParsedHandoffSession {
	return parseHandoffEntries(parseSessionFileEntries(sessionFile));
}

export function latestRequest(
	records: readonly HandoffRequestRecord[],
): HandoffRequestRecord | undefined {
	return records.length === 0 ? undefined : records[records.length - 1];
}

export function appendRequestPhase(
	current: HandoffRequestRecord | undefined,
	next: HandoffRequestRecord,
): { ok: true; record: HandoffRequestRecord } | { ok: false; reason: string } {
	const reduced = reduceHandoffPhase(current?.phase, next.phase);
	if (!reduced.ok) return reduced;
	if (current && current.requestId !== next.requestId && isHandoffProgressPhase(current.phase)) {
		return { ok: false, reason: "cannot change requestId while a request is live" };
	}
	if (current && isHandoffTerminalPhase(current.phase) && current.requestId === next.requestId) {
		return { ok: false, reason: `terminal request ${current.requestId} cannot be reused` };
	}
	return { ok: true, record: next };
}

function asRequest(value: unknown): HandoffRequestRecord | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const row = value as HandoffRequestRecord;
	if (typeof row.requestId !== "string" || typeof row.phase !== "string") {
		return undefined;
	}
	return row;
}

function asAttempt(value: unknown): HandoffAttemptRecord | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const row = value as HandoffAttemptRecord;
	if (typeof row.requestId !== "string" || typeof row.phase !== "string") {
		return undefined;
	}
	return row;
}

function asContextDetails(value: unknown): HandoffContextDetails | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const row = value as HandoffContextDetails;
	if (typeof row.requestId !== "string" || typeof row.sourceSessionId !== "string") {
		return undefined;
	}
	return row;
}

function extractXml(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (
			part !== null &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			return (part as { text: string }).text;
		}
	}
	return undefined;
}
