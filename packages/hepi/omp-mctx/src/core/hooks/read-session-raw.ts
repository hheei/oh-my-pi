export interface RawMessageParts {
	id: string;
	role: string;
	parts: unknown[];
	createdAt?: number | null | undefined;
	version?: string | number | null | undefined;
	skipTags?: boolean | undefined;
}

export interface RawMessage extends RawMessageParts {
	ordinal: number;
}

export interface RawMessageOrdinalAnchor {
	timeCreated: number;
	id: string;
}

export interface RawMessageOrdinalEntry extends RawMessageOrdinalAnchor {
	contributesOrdinal: boolean;
	hasValidInfo: boolean;
}

export function isRawCompactionSummaryInfo(info: unknown): boolean {
	if (info === null || typeof info !== "object" || Array.isArray(info)) return false;
	const candidate = info as Record<string, unknown>;
	return candidate.summary === true && candidate.finish === "stop";
}

export interface InMemoryMessageView {
	id: string;
	role: string;
	parts: unknown[];
	summary?: boolean | undefined;
	finish?: string | undefined;
}

export interface InMemoryTailResult {
	messages: RawMessage[];
	absoluteMessageCount: number;
	anchorFound: boolean;
}

export function extractInMemoryMessageViews(
	messages: readonly { info?: unknown; parts?: unknown }[],
): InMemoryMessageView[] {
	return messages.map((message) => {
		const info = (message.info ?? {}) as Record<string, unknown>;
		return {
			id: typeof info.id === "string" ? info.id : "",
			role: typeof info.role === "string" ? info.role : "unknown",
			parts: Array.isArray(message.parts) ? message.parts : [],
			...(info.summary === true ? { summary: true } : {}),
			...(typeof info.finish === "string" ? { finish: info.finish } : {}),
		};
	});
}

/** Convert Pi's in-memory session tail to stable, absolute raw-message ordinals. */
export function buildInMemoryTailRawMessages(args: {
	messages: readonly InMemoryMessageView[];
	lastCompartmentEnd: number;
	anchorMessageId: string | null;
}): InMemoryTailResult | null {
	const filtered = args.messages.filter(
		(message) => !(message.summary === true && message.finish === "stop"),
	);
	if (filtered.length === 0) return null;

	let startIndex = 0;
	let anchorFound = false;
	let ordinal = Math.max(1, args.lastCompartmentEnd + 1);
	if (args.anchorMessageId) {
		const anchorIndex = filtered.findIndex((message) => message.id === args.anchorMessageId);
		if (anchorIndex >= 0) {
			startIndex = anchorIndex;
			anchorFound = true;
			ordinal = args.lastCompartmentEnd;
		}
	}

	const messages: RawMessage[] = [];
	for (let index = startIndex; index < filtered.length; index += 1) {
		const message = filtered[index];
		if (!message || message.id.length === 0) {
			ordinal += 1;
			continue;
		}
		messages.push({
			ordinal,
			id: message.id,
			role: message.role,
			parts: message.parts,
			version: null,
		});
		ordinal += 1;
	}

	return {
		messages,
		absoluteMessageCount: Math.max(0, ordinal - 1),
		anchorFound,
	};
}
