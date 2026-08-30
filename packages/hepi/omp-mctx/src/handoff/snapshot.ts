import type { Compartment } from "#core/features/compartment-storage";
import type { TagEntry } from "#core/features/types";
import { renderDecayedCompartments } from "#core/hooks/decay-render";
import { estimateImageTokensFromDataUrl } from "#core/hooks/image-token-estimate";
import { estimateTokens } from "#core/hooks/read-session-formatting";
import {
	assertPayloadLimit,
	type BudgetPlan,
	collectHandoffImages,
	HANDOFF_RECENT_COUNT,
	type HandoffFence,
	type HandoffSourceContextSnapshot,
	hashBytes,
	hashRecentMessages,
	hashSessionHistory,
	planHandoffBudget,
	renderHandoffContextXml,
	type SerializedRecentMessage,
	serializeRecentMessages,
} from "./model";

export interface SnapshotInputs {
	readonly sessionId: string;
	readonly sessionPath: string;
	readonly projectIdentity: string;
	readonly model: string;
	readonly thinkingLevel: string;
	readonly systemPrompt: string;
	readonly toolInventory: string;
	readonly memoryRevision: string;
	readonly branchFingerprint: string;
	readonly usableLimit: number;
	readonly executeCeiling: number;
	readonly prefixTokens: number;
	readonly compartments: readonly Compartment[];
	readonly entries: readonly unknown[];
	readonly tags: readonly TagEntry[];
}

export type FreezeSnapshotResult =
	| {
			readonly ok: true;
			readonly snapshot: HandoffSourceContextSnapshot;
			readonly plan: BudgetPlan;
	  }
	| { readonly ok: false; readonly reason: string };

export function freezeHandoffSnapshot(inputs: SnapshotInputs): FreezeSnapshotResult {
	const recentSource = collectRecentLogicalMessages(
		inputs.entries,
		inputs.tags,
		HANDOFF_RECENT_COUNT,
	);
	if (!recentSource.ok) return recentSource;
	const serialized = serializeRecentMessages(recentSource.messages);
	if (!serialized.ok) return serialized;
	const recentTokens = estimateRecentTokens(serialized.messages);
	const planned = planHandoffBudget({
		usableLimit: inputs.usableLimit,
		executeCeiling: inputs.executeCeiling,
		prefixTokens: inputs.prefixTokens,
		recentTokens,
		estimateTokens,
	});
	if (!planned.ok) return planned;
	const sessionHistory = renderDecayedCompartments({
		compartments: [...(inputs.compartments ?? [])],
		historyBudgetTokens: planned.plan.historyBudget,
	});
	const fence: HandoffFence = {
		projectIdentity: inputs.projectIdentity,
		sessionId: inputs.sessionId,
		sessionPath: inputs.sessionPath,
		model: inputs.model,
		thinkingLevel: inputs.thinkingLevel,
		systemPromptHash: hashBytes(inputs.systemPrompt),
		toolInventoryHash: hashBytes(inputs.toolInventory),
		memoryRevision: inputs.memoryRevision,
		compartmentRevision: hashCompartments(inputs.compartments),
		sessionHistoryHash: hashSessionHistory(sessionHistory),
		recentFiveHash: hashRecentMessages(serialized.messages),
		branchFingerprint: inputs.branchFingerprint,
	};
	const snapshot: HandoffSourceContextSnapshot = {
		sessionHistory,
		recentMessages: serialized.messages,
		fence,
		tokens: {
			usableLimit: planned.plan.usableLimit,
			executeCeiling: planned.plan.executeCeiling,
			prefixTokens: planned.plan.prefixTokens,
			summaryReserve: planned.plan.summaryReserve,
			recentTokens: planned.plan.recentTokens,
			historyTokens: estimateTokens(sessionHistory),
			wrapperTokens: planned.plan.wrapperTokens,
		},
	};
	const payloadError = assertPayloadLimit(snapshot, "Source Context Snapshot");
	if (payloadError) return { ok: false, reason: payloadError };
	const previewError = assertProjectedContextLimit({
		snapshot,
		summary: "x".repeat(Math.max(1, planned.plan.summaryReserve * 3)),
		ceiling: planned.plan.executeCeiling,
		prefixTokens: planned.plan.prefixTokens,
	});
	if (previewError) return { ok: false, reason: previewError };
	return { ok: true, snapshot, plan: planned.plan };
}

export function assertProjectedContextLimit(args: {
	snapshot: HandoffSourceContextSnapshot;
	summary: string;
	ceiling: number;
	prefixTokens: number;
}): string | undefined {
	const xml = renderHandoffContextXml({
		sessionId: args.snapshot.fence.sessionId,
		model: args.snapshot.fence.model,
		generatedAt: "1970-01-01T00:00:00.000Z",
		sessionHistory: args.snapshot.sessionHistory,
		recentMessages: args.snapshot.recentMessages,
		summary: args.summary,
	});
	const images = collectHandoffImages(args.snapshot.recentMessages);
	const tokens =
		args.prefixTokens +
		estimateTokens(xml) +
		images.reduce(
			(sum, image) =>
				sum + estimateImageTokensFromDataUrl(`data:${image.mimeType};base64,${image.data}`),
			0,
		);
	if (tokens > args.ceiling) {
		return `projected destination input is ${tokens} tokens, above the ${args.ceiling}-token ceiling`;
	}
	return undefined;
}

export function collectRecentLogicalMessages(
	entries: readonly unknown[],
	tags: readonly TagEntry[],
	count: number,
):
	| { readonly ok: true; readonly messages: unknown[] }
	| { readonly ok: false; readonly reason: string } {
	const dropped = new Map<string, TagEntry>();
	for (const tag of tags) {
		if (tag.status === "dropped") dropped.set(tag.messageId, tag);
	}
	const folded: Array<{ role: "user" | "assistant"; parts: unknown[] }> = [];
	let pendingTools: unknown[] = [];
	for (const entry of entries) {
		const message = messageFromEntry(entry);
		if (!message) continue;
		const role = message.role;
		if (role === "toolResult") {
			const foldedTool = foldToolResult(message, dropped);
			if (!foldedTool.ok) return foldedTool;
			pendingTools.push(foldedTool.part);
			continue;
		}
		if (role !== "user" && role !== "assistant") {
			return { ok: false, reason: `unsupported recent-message role ${String(role)}` };
		}
		if (role === "user" && pendingTools.length > 0) {
			folded.push({
				role: "user",
				parts: [...pendingTools, ...partsFromMessage(message, dropped)],
			});
			pendingTools = [];
			continue;
		}
		if (pendingTools.length > 0) {
			folded.push({ role: "user", parts: pendingTools });
			pendingTools = [];
		}
		folded.push({
			role,
			parts: partsFromMessage(message, dropped),
		});
	}
	if (pendingTools.length > 0) {
		folded.push({ role: "user", parts: pendingTools });
	}
	return { ok: true, messages: folded.slice(-count) };
}

export function hashCompartments(compartments: readonly Compartment[]): string {
	return hashBytes(
		JSON.stringify(
			compartments.map((compartment) => ({
				id: compartment.id,
				sequence: compartment.sequence,
				startMessage: compartment.startMessage,
				endMessage: compartment.endMessage,
				title: compartment.title,
				content: compartment.content,
				p1: compartment.p1,
				p2: compartment.p2,
				p3: compartment.p3,
				p4: compartment.p4,
			})),
		),
	);
}

export function hashToolInventory(tools: readonly unknown[]): string {
	return hashBytes(
		JSON.stringify(
			tools.map((tool) => {
				const row = tool as { name?: unknown; description?: unknown; parameters?: unknown };
				return {
					name: row.name,
					description: row.description,
					parameters: row.parameters,
				};
			}),
		),
	);
}

export function hashMemories(
	memories: readonly { id: number; updatedAt: number; content: string }[],
): string {
	return hashBytes(
		JSON.stringify(
			memories.map((memory) => ({
				id: memory.id,
				updatedAt: memory.updatedAt,
				content: memory.content,
			})),
		),
	);
}

export function modelVisibleBranchFingerprint(entries: readonly unknown[]): string {
	const ids: string[] = [];
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		const row = entry as {
			id?: unknown | undefined;
			type?: unknown | undefined;
			customType?: unknown | undefined;
			message?: unknown | undefined;
		};
		if (typeof row.id !== "string") continue;
		if (row.type === "custom" || row.type === "custom_entry") continue;
		if (row.type === "custom_message") {
			ids.push(row.id);
			continue;
		}
		if (row.type === "message" && row.message && typeof row.message === "object") {
			ids.push(row.id);
		}
	}
	return hashBytes(ids.join("\n"));
}

function estimateRecentTokens(messages: readonly SerializedRecentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message.text);
		for (const image of message.images) {
			tokens += estimateImageTokensFromDataUrl(`data:${image.mimeType};base64,${image.data}`);
		}
	}
	return tokens;
}

function messageFromEntry(entry: unknown): Record<string, unknown> | undefined {
	if (entry === null || typeof entry !== "object") return undefined;
	const row = entry as { type?: unknown; message?: unknown; id?: unknown };
	if (row.type !== "message" || row.message === null || typeof row.message !== "object") {
		return undefined;
	}
	const message = row.message as Record<string, unknown>;
	return { ...message, id: typeof row.id === "string" ? row.id : message.id };
}

function partsFromMessage(
	message: Record<string, unknown>,
	dropped: ReadonlyMap<string, TagEntry>,
): unknown[] {
	const id = typeof message.id === "string" ? message.id : "";
	const drop = dropped.get(id);
	const content = message.content;
	if (typeof content === "string") {
		if (drop?.type === "message") return [{ type: "text", text: `[dropped]` }];
		return [{ type: "text", text: content }];
	}
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => normalizeDroppedPart(part, drop));
}

function normalizeDroppedPart(part: unknown, drop: TagEntry | undefined): unknown[] {
	if (part === null || typeof part !== "object") return [part];
	const row = part as Record<string, unknown>;
	if (drop?.type === "message" && row.type === "text") {
		return [{ type: "text", text: "[dropped]" }];
	}
	if (
		drop?.type === "tool" &&
		(row.type === "toolCall" || row.type === "tool") &&
		drop.dropMode === "full"
	) {
		return [];
	}
	if (drop?.type === "tool" && (row.type === "toolCall" || row.type === "tool")) {
		return [
			{
				...row,
				arguments: {},
				state: { ...(asRecord(row.state) ?? {}), output: "[dropped]" },
			},
		];
	}
	return [part];
}

function foldToolResult(
	message: Record<string, unknown>,
	dropped: ReadonlyMap<string, TagEntry>,
): { ok: true; part: Record<string, unknown> } | { ok: false; reason: string } {
	const id = typeof message.id === "string" ? message.id : "";
	const drop = dropped.get(id);
	const name = typeof message.toolName === "string" ? message.toolName : "unknown";
	if (drop?.type === "tool" && drop.dropMode === "full") {
		return { ok: true, part: { type: "tool", tool: name, state: { output: "[dropped]" } } };
	}
	const content = message.content;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part !== null && typeof part === "object") {
				const row = part as Record<string, unknown>;
				if (
					row.type &&
					row.type !== "text" &&
					row.type !== "image" &&
					row.type !== "tool" &&
					row.type !== "toolCall"
				) {
					return {
						ok: false,
						reason: `unsupported tool-result part type ${String(row.type)}`,
					};
				}
			}
		}
	}
	const output =
		drop?.type === "tool"
			? "[dropped]"
			: typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((part) => {
								if (part !== null && typeof part === "object") {
									const row = part as Record<string, unknown>;
									if (typeof row.text === "string") return row.text;
								}
								return "";
							})
							.filter(Boolean)
							.join("\n")
					: "";
	return {
		ok: true,
		part: {
			type: "tool",
			tool: name,
			state: { output },
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}
