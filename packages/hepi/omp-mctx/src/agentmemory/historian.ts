import * as crypto from "node:crypto";
import { prompt } from "@oh-my-pi/pi-utils";
import backgroundPrompt from "./historian-background.md" with { type: "text" };

/** Evidence origin used by the bridge. Retrieval is context, never evidence. */
export type HistorianEvidenceKind = "user" | "tool" | "assistant" | "retrieval" | "memory_save";

export type HistorianEvidence = {
	kind: HistorianEvidenceKind;
	content: string;
	/** Stable host identity. Ordinals are deliberately not used as identity. */
	hostEntryId?: string;
	toolCallId?: string;
	harnessId?: string;
	contentFingerprint?: string;
	ordinal?: number;
	branchId?: string;
	projectionId?: string;
	/** True when this item was recalled, generated from recalled text, or saved from it. */
	derivedFromRetrieval?: boolean;
	/** Explicit taint propagated from an injected turn or memory tool result. */
	tainted?: boolean;
};

export type HistorianRecall = {
	content: string;
	id?: string;
	project: string;
	agentId?: string;
	sessionId?: string;
};

export type HistorianBackground = {
	recall: readonly HistorianRecall[];
	scope: { project: string; agentId?: string; activeSessionId?: string };
};

export type HistorianSourceIdentity = {
	hostEntryId: string;
	toolCallId?: string;
	harnessId?: string;
	contentFingerprint: string;
	branchId?: string;
	projectionId?: string;
};

export type HistorianCandidateType = "pattern" | "preference" | "architecture" | "bug" | "workflow" | "fact";

export type HistorianCandidate = {
	content: string;
	type: HistorianCandidateType;
	sourceRefs: readonly HistorianSourceIdentity[];
	background?: HistorianBackground;
};

export type CandidateAdmission =
	| { accepted: true; candidate: HistorianCandidate }
	| {
			accepted: false;
			reason:
				| "empty"
				| "tainted"
				| "no-independent-evidence"
				| "ambiguous-provenance"
				| "stale-provenance"
				| "invalid-type";
	  };

const NATIVE_TYPES = new Set<HistorianCandidateType>([
	"pattern",
	"preference",
	"architecture",
	"bug",
	"workflow",
	"fact",
]);

/** Explicit bridge from mctx's parser taxonomy to agentmemory's taxonomy. */
const PARSER_CATEGORY_MAP: Record<string, HistorianCandidate["type"]> = {
	PROJECT_RULES: "workflow",
	ARCHITECTURE: "architecture",
	CONSTRAINTS: "fact",
	CONFIG_VALUES: "fact",
	NAMING: "preference",
	BUG: "bug",
	WORKFLOW: "workflow",
};

export function mapParserCategory(category: string | undefined): HistorianCandidate["type"] | undefined {
	const value = normalized(category ?? "").toUpperCase();
	return PARSER_CATEGORY_MAP[value] ?? normalizeHistorianType(category);
}

function normalized(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

export function contentFingerprint(content: string): string {
	return crypto.createHash("sha256").update(normalized(content)).digest("hex");
}

/** Remote recall is attached to the prompt as background, never merged into evidence. */
export function createHistorianBackground(
	recall: readonly HistorianRecall[],
	scope: { project: string; agentId?: string; activeSessionId?: string },
): HistorianBackground {
	const scoped = recall.filter(
		item =>
			item.project === scope.project &&
			(scope.agentId === undefined || item.agentId === scope.agentId) &&
			(scope.activeSessionId === undefined || item.sessionId !== scope.activeSessionId),
	);
	return { recall: scoped, scope: { ...scope } };
}

export function formatHistorianBackground(background: HistorianBackground): string {
	if (background.recall.length === 0) return "";
	return prompt.render(backgroundPrompt, {
		recall: background.recall.map(item => `- ${item.content.trim()}`).join("\n"),
	});
}

function isIndependentEvidence(evidence: HistorianEvidence): boolean {
	return (
		(evidence.kind === "user" || evidence.kind === "tool") &&
		!evidence.derivedFromRetrieval &&
		!evidence.tainted &&
		evidence.content.trim().length > 0
	);
}

/** A candidate needs two independent stable references, or one explicit tool/user source. */
export function admitHistorianCandidate(args: {
	content: string;
	type?: string;
	evidence: readonly HistorianEvidence[];
	background?: HistorianBackground;
}): CandidateAdmission {
	const content = normalized(args.content);
	if (!content) return { accepted: false, reason: "empty" };
	const tainted = args.evidence.some(
		item => item.tainted || item.derivedFromRetrieval || item.kind === "retrieval" || item.kind === "memory_save",
	);
	const independent = args.evidence.filter(isIndependentEvidence);
	if (independent.length === 0) return { accepted: false, reason: tainted ? "tainted" : "no-independent-evidence" };
	const reconciled = reconcileHistorianProvenance(independent);
	if (!reconciled.ok) return { accepted: false, reason: reconciled.reason };
	const type = mapParserCategory(args.type);
	if (!type) return { accepted: false, reason: "invalid-type" };
	return {
		accepted: true,
		candidate: {
			content,
			type,
			sourceRefs: reconciled.sources,
			...(args.background ? { background: args.background } : {}),
		},
	};
}

/** Preserve the backend's native categories without inventing backend policy. */
export function normalizeHistorianType(type: string | undefined): HistorianCandidateType | undefined {
	const value = normalized(type ?? "").toLowerCase();
	if (NATIVE_TYPES.has(value as HistorianCandidate["type"])) return value as HistorianCandidate["type"];
	// The public agentmemory contract accepts only these native categories.
	// Unknown model output is rejected by callers rather than silently
	// changing its meaning.
	return undefined;
}

export type ProvenanceReconciliation =
	| { ok: true; sources: readonly HistorianSourceIdentity[] }
	| { ok: false; reason: "ambiguous-provenance" | "stale-provenance" };

/** Resolve folded observations to stable IDs; never silently fall back to ordinals. */
export function reconcileHistorianProvenance(evidence: readonly HistorianEvidence[]): ProvenanceReconciliation {
	const sources: HistorianSourceIdentity[] = [];
	const seen = new Set<string>();
	for (const item of evidence) {
		const hostEntryId = item.hostEntryId?.trim();
		if (!hostEntryId) return { ok: false, reason: "stale-provenance" };
		const fingerprint = item.contentFingerprint ?? contentFingerprint(item.content);
		if (
			!fingerprint ||
			(item.contentFingerprint !== undefined && item.contentFingerprint !== contentFingerprint(item.content))
		) {
			return { ok: false, reason: "stale-provenance" };
		}
		const source: HistorianSourceIdentity = {
			hostEntryId,
			...(item.toolCallId?.trim() ? { toolCallId: item.toolCallId.trim() } : {}),
			...(item.harnessId?.trim() ? { harnessId: item.harnessId.trim() } : {}),
			contentFingerprint: fingerprint,
			...(item.branchId?.trim() ? { branchId: item.branchId.trim() } : {}),
			...(item.projectionId?.trim() ? { projectionId: item.projectionId.trim() } : {}),
		};
		const key = JSON.stringify(source);
		if (seen.has(key)) continue;
		seen.add(key);
		sources.push(source);
	}
	if (sources.length === 0) return { ok: false, reason: "stale-provenance" };
	const hostEntries = new Set(sources.map(source => source.hostEntryId));
	if (hostEntries.size !== sources.length && sources.some(source => source.toolCallId === undefined)) {
		return { ok: false, reason: "ambiguous-provenance" };
	}
	return { ok: true, sources };
}
