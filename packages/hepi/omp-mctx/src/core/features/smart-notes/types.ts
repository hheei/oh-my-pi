import type { Note } from "../storage-notes";

export const SMART_NOTE_CHECK_POLICY_VERSION = 1;

export const SMART_NOTE_CHECK_FLOOR_MS = 5 * 60 * 1000;
export const SMART_NOTE_CHECK_CEILING_MS = 24 * 60 * 60 * 1000;
export const SMART_NOTE_CHECK_DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
export const SMART_NOTE_CHECK_MAX_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;
export const SMART_NOTE_CHECK_LIVENESS_RECHECK_MS = 24 * 60 * 60 * 1000;

export type SmartNoteCapabilityName = "readFile" | "gitHeadSha" | "gitTag" | "gitLog" | "httpGet";

export type SmartNoteCheckStatus = "uncompiled" | "compiled" | "failing" | "fallback";

export interface SmartNoteCheckManifest {
	capabilities: SmartNoteCapabilityName[];
	readFiles?: string[] | undefined;
	hosts?: string[] | undefined;
	urls?: string[] | undefined;
	signals?: string[] | undefined;
	summary?: string | undefined;
}

export interface SmartNoteCheckNote extends Note {
	compiledCheck: string | null;
	manifestJson: string | null;
	checkHash: string | null;
	checkCron: string | null;
	checkVersion: number | null;
	checkStatus: SmartNoteCheckStatus;
	checkFailureCount: number;
	checkNetworkFailureCount: number;
	checkQuarantinedUntil: number | null;
	checkNextDueAt: number | null;
	checkCompiledAt: number | null;
	checkFalseSinceAt: number | null;
	checkLastLivenessAt: number | null;
	policyVersion: number;
}

export interface SmartNoteCheckResult {
	met: boolean;
}

export interface SmartNoteNetworkErrorOptions {
	terminal?: boolean | undefined;
}

export class SmartNoteNetworkError extends Error {
	readonly isSmartNoteNetworkError = true;
	readonly terminal: boolean;

	constructor(message: string, options: SmartNoteNetworkErrorOptions = {}) {
		super(message);
		this.name = "SmartNoteNetworkError";
		this.terminal = options.terminal ?? false;
	}
}

export class SmartNoteSecurityError extends Error {
	readonly isSmartNoteSecurityError = true;

	constructor(message: string) {
		super(message);
		this.name = "SmartNoteSecurityError";
	}
}

export function isSmartNoteNetworkError(error: unknown): boolean {
	return (
		error instanceof SmartNoteNetworkError ||
		(error instanceof Error &&
			(error.name === "SmartNoteNetworkError" ||
				error.message.includes("SmartNoteNetworkError") ||
				error.message.includes("SMART_NOTE_NETWORK")))
	);
}

export function isTerminalSmartNoteNetworkError(error: unknown): error is SmartNoteNetworkError {
	return error instanceof SmartNoteNetworkError && error.terminal;
}

export function parseSmartNoteManifest(json: string | null): SmartNoteCheckManifest {
	if (!json) return { capabilities: [] };
	try {
		const parsed = JSON.parse(json) as Partial<SmartNoteCheckManifest>;
		const capabilities = Array.isArray(parsed.capabilities)
			? parsed.capabilities.filter((c): c is SmartNoteCapabilityName =>
					["readFile", "gitHeadSha", "gitTag", "gitLog", "httpGet"].includes(String(c)),
				)
			: [];
		const readFiles = stringArray(parsed.readFiles);
		const hosts = stringArray(parsed.hosts);
		const urls = stringArray(parsed.urls);
		const signals = stringArray(parsed.signals);
		return {
			capabilities,
			...(readFiles === undefined ? {} : { readFiles }),
			...(hosts === undefined ? {} : { hosts }),
			...(urls === undefined ? {} : { urls }),
			...(signals === undefined ? {} : { signals }),
			...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
		};
	} catch {
		return { capabilities: [] };
	}
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const arr = value.filter((item): item is string => typeof item === "string");
	return arr.length > 0 ? arr : undefined;
}
