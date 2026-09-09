/**
 * Per-message semantic token accounting for Pi's final context projection.
 *
 * Uses the caller-supplied active-model tokenizer when present. Immutable
 * Recall Event identities are supplied by the ledger's active-branch query;
 * no message content, source label, or ID prefix participates in recall
 * classification. Tool definitions are deliberately excluded because Pi sends
 * them separately and status measures that observable prefix on its own.
 */

import { estimateTokens } from "#core/hooks/read-session-formatting";

export interface PiMessageTokenCounts {
	conversation: number;
	toolCall: number;
	recall: number;
}

export interface PiMessageTokenCacheEntry {
	fingerprint: readonly (string | null)[];
	counts: PiMessageTokenCounts;
}

export interface TokenizePiMessagesOptions {
	cache: Map<string, PiMessageTokenCacheEntry>;
	stableId: (message: object) => string | undefined;
	/** The active kernel model's public tokenizer; omit only for legacy callers. */
	countTokens?: ((text: string) => number) | undefined;
	/** Exact immutable Recall Event identities admitted on the active projection branch. */
	recallEventIds?: ReadonlySet<string> | undefined;
	onTiming?:
		| ((phase: "cacheValidation" | "bpe" | "cachePrune", elapsedMs: number) => void)
		| undefined;
}

interface MaybePart {
	type?: string | undefined;
	text?: string | undefined;
	thinking?: string | undefined;
	thinkingSignature?: string | undefined;
	textSignature?: string | undefined;
	data?: string | undefined;
	mimeType?: string | undefined;
	name?: string | undefined;
	arguments?: unknown | undefined;
}

interface MaybeMessage {
	id?: unknown;
	role?: string | undefined;
	content?: unknown | undefined;
	toolCallId?: string | undefined;
}
/**
 * Compute conversation + tool-call token totals for a Pi message array.
 *
 * Stable SessionEntry ids can reuse a per-message result when every field that
 * affects token accounting still matches. The fingerprint keeps exact text,
 * signatures, tool names, and canonical tool arguments while omitting fields the
 * counter never reads (including base64 image bytes, whose count is fixed).
 * Synthetic injection messages have no stable id and always run.
 */
export function tokenizePiMessages(
	messages: unknown[],
	options?: TokenizePiMessagesOptions,
): PiMessageTokenCounts {
	let conversation = 0;
	let toolCall = 0;
	let recall = 0;
	const countTokens = options?.countTokens ?? estimateTokens;
	let cacheValidationMs = 0;
	let bpeMs = 0;
	const liveIds = options ? new Set<string>() : undefined;

	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const cacheValidationStart = options?.onTiming ? performance.now() : 0;
		const resolvedStableId = options?.stableId(raw);
		// Cache equality is only meaningful when JSON.stringify observes the same
		// fields the tokenizer reads. Pi's JSONL messages satisfy this shape; custom
		// prototypes and toJSON hooks must take the uncached path.
		const stableId =
			resolvedStableId !== undefined && isTokenCacheSafeMessage(raw) ? resolvedStableId : undefined;
		const fingerprint =
			stableId === undefined ? null : buildTokenCacheFingerprint(raw, options?.recallEventIds);
		if (stableId !== undefined && fingerprint !== null) {
			liveIds?.add(stableId);
			const cached = options?.cache.get(stableId);
			if (cached && tokenCacheFingerprintsEqual(cached.fingerprint, fingerprint)) {
				conversation += cached.counts.conversation;
				toolCall += cached.counts.toolCall;
				recall += cached.counts.recall;
				cacheValidationMs += performance.now() - cacheValidationStart;
				continue;
			}
		}
		cacheValidationMs += performance.now() - cacheValidationStart;
		const bpeStart = options?.onTiming ? performance.now() : 0;
		const beforeConversation = conversation;
		const beforeToolCall = toolCall;
		const beforeRecall = recall;
		try {
			const msg = raw as MaybeMessage & { id?: unknown };
			const content = msg.content;
			const isRecall =
				typeof msg.id === "string" && options?.recallEventIds?.has(msg.id) === true;
			const addConversation = (text: string) => {
				if (isRecall) recall += countTokens(text);
				else conversation += countTokens(text);
			};

			// User/Assistant: content is array of PiTextContent | PiImageContent
			// | PiThinkingContent | PiToolCall (or a plain string for user
			// messages — Pi allows that shape too).
			if (msg.role === "user" || msg.role === "assistant") {
				if (typeof content === "string") {
					addConversation(content);
					continue;
				}
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const p = part as MaybePart;
					switch (p.type) {
						case "text":
							if (typeof p.text === "string") addConversation(p.text);
							if (typeof p.textSignature === "string") addConversation(p.textSignature);
							break;
						case "thinking":
							if (typeof p.thinking === "string") addConversation(p.thinking);
							if (typeof p.thinkingSignature === "string") addConversation(p.thinkingSignature);
							break;
						case "image":
							if (isRecall) recall += 1200;
							else conversation += 1200;
							break;
						case "toolCall":
							if (typeof p.name === "string") toolCall += countTokens(p.name);
							if (p.arguments !== undefined) {
								const s = typeof p.arguments === "string" ? p.arguments : safeJsonStringify(p.arguments);
								if (s) toolCall += countTokens(s);
							}
							break;
					}
				}
				continue;
			}

			if (msg.role === "toolResult") {
				if (typeof content === "string") {
					toolCall += countTokens(content);
					continue;
				}
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const p = part as MaybePart;
					if (p.type === "text" && typeof p.text === "string") toolCall += countTokens(p.text);
					else if (p.type === "image") toolCall += 1200;
				}
			}
		} finally {
			bpeMs += performance.now() - bpeStart;
			if (stableId !== undefined && fingerprint !== null) {
				options?.cache.set(stableId, {
					fingerprint,
					counts: {
						conversation: conversation - beforeConversation,
						toolCall: toolCall - beforeToolCall,
						recall: recall - beforeRecall,
					},
				});
			}
		}
	}

	if (options && liveIds) {
		const cachePruneStart = options.onTiming ? performance.now() : 0;
		for (const id of options.cache.keys()) {
			if (!liveIds.has(id)) options.cache.delete(id);
		}
		options.onTiming?.("cachePrune", performance.now() - cachePruneStart);
	}
	options?.onTiming?.("cacheValidation", cacheValidationMs);
	options?.onTiming?.("bpe", bpeMs);
	return { conversation, toolCall, recall };
}

function buildTokenCacheFingerprint(
	value: object,
	recallEventIds?: ReadonlySet<string>,
): readonly (string | null)[] {
	const message = value as MaybeMessage;
	const role = typeof message.role === "string" ? message.role : null;
	const messageId = message.id;
	const recallClass = typeof messageId === "string" && recallEventIds?.has(messageId) === true ? "recall" : "conversation";
	const fingerprint: (string | null)[] = [role, recallClass];
	if (role !== "user" && role !== "assistant" && role !== "toolResult") {
		return fingerprint;
	}
	if (typeof message.content === "string") {
		fingerprint.push("string", message.content);
		return fingerprint;
	}
	if (!Array.isArray(message.content)) {
		fingerprint.push("non-array");
		return fingerprint;
	}
	fingerprint.push("parts");
	for (const rawPart of message.content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as MaybePart;
		if (role === "toolResult") {
			if (part.type === "text" && typeof part.text === "string") {
				fingerprint.push("text", part.text);
			} else if (part.type === "image") {
				fingerprint.push("image");
			}
			continue;
		}
		switch (part.type) {
			case "text":
				fingerprint.push(
					"text",
					typeof part.text === "string" ? part.text : null,
					typeof part.textSignature === "string" ? part.textSignature : null,
				);
				break;
			case "thinking":
				fingerprint.push(
					"thinking",
					typeof part.thinking === "string" ? part.thinking : null,
					typeof part.thinkingSignature === "string" ? part.thinkingSignature : null,
				);
				break;
			case "image":
				fingerprint.push("image");
				break;
			case "toolCall": {
				const argumentsJson =
					part.arguments === undefined
						? null
						: typeof part.arguments === "string"
							? part.arguments
							: safeJsonStringify(part.arguments);
				fingerprint.push(
					"toolCall",
					typeof part.name === "string" ? part.name : null,
					argumentsJson,
				);
				break;
			}
		}
	}
	return fingerprint;
}

function tokenCacheFingerprintsEqual(
	left: readonly (string | null)[],
	right: readonly (string | null)[],
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function isTokenCacheSafeMessage(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if ("toJSON" in value) return false;
	if (!isJsonVisibleDataProperty(value, "role") || !isJsonVisibleDataProperty(value, "content")) {
		return false;
	}
	return isPlainJsonData((value as { content?: unknown }).content, new Set());
}

function isJsonVisibleDataProperty(value: object, key: string): boolean {
	if (!(key in value)) return true;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor;
}

function isPlainJsonData(value: unknown, seen: Set<object>): boolean {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "undefined"
	) {
		return true;
	}
	if (typeof value !== "object" || seen.has(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		return false;
	}
	if ("toJSON" in value) return false;
	seen.add(value);
	try {
		for (const key of Reflect.ownKeys(value)) {
			if (Array.isArray(value) && key === "length") continue;
			if (typeof key !== "string") return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				return false;
			}
			if (!isPlainJsonData(descriptor.value, seen)) return false;
		}
		return true;
	} finally {
		seen.delete(value);
	}
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}
