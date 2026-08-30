/**
 * Feature-neutral resolution of Pi `getContextUsage()` at any session moment.
 *
 * Pi only estimates session messages. A brand-new session therefore reports
 * `tokens = 0` even though the next provider request already carries the system
 * prompt (including `<available_skills>`) and the `tools[]` schemas. Compaction
 * reports `tokens = null`, which means unknown — never substitute a prefix.
 *
 * This module does not read `ExtensionContext` or own session state. Callers
 * collect live usage, prompt text, and tool schemas. Tokenizer policy stays
 * with the caller: the default is `ceil(chars/4)`, not a model encoder.
 */

export type PiContextUsageReading = {
	readonly tokens?: number | null;
	readonly percent?: number | null;
	readonly contextWindow?: number | null;
};

export type PiPrefixTool = {
	readonly name?: string | undefined;
	readonly description?: string | undefined;
	readonly parameters?: unknown;
};

export type PiPrefixTokens = {
	readonly systemPromptTokens: number;
	readonly toolDefinitionTokens: number;
	readonly tokens: number;
};

export type PiContextUsageSource = "live" | "prefix" | "unknown";

export type ResolvedPiContextUsage = {
	readonly tokens: number | undefined;
	readonly percent: number | undefined;
	readonly contextWindow: number | undefined;
	readonly source: PiContextUsageSource;
	readonly prefix: PiPrefixTokens;
};

export type EstimateTextTokens = (text: string) => number;

/** Structural fallback. Not a model tokenizer. */
export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

export function estimatePiPrefixTokens(args: {
	readonly systemPrompt?: string;
	readonly tools?: ReadonlyArray<PiPrefixTool>;
	readonly estimateTokens?: EstimateTextTokens;
}): PiPrefixTokens {
	const estimate = args.estimateTokens ?? estimateTextTokens;
	const systemPromptTokens =
		typeof args.systemPrompt === "string" && args.systemPrompt.length > 0
			? estimate(args.systemPrompt)
			: 0;
	const toolDefinitionTokens = estimatePiToolDefinitionTokens(args.tools ?? [], estimate);
	return {
		systemPromptTokens,
		toolDefinitionTokens,
		tokens: systemPromptTokens + toolDefinitionTokens,
	};
}

export function estimatePiToolDefinitionTokens(
	tools: ReadonlyArray<PiPrefixTool>,
	estimate: EstimateTextTokens = estimateTextTokens,
): number {
	let total = 0;
	for (const tool of tools) {
		total += estimate(
			`${tool.name ?? ""}\n${tool.description ?? ""}\n${safeStringify(tool.parameters)}`,
		);
	}
	return total;
}

/**
 * Resolve display/live input tokens from a Pi usage reading plus optional prefix.
 *
 * `prefixTokens` is typically `estimatePiPrefixTokens(...).tokens`. Callers may
 * add their own static adjuncts (for example already-injected m[0]) before
 * passing the sum; those adjuncts only apply when live tokens are `0`.
 */
export function resolvePiContextUsage(input: {
	readonly live?: PiContextUsageReading | undefined;
	readonly prefixTokens?: number | undefined;
	readonly contextWindow?: number | undefined;
	readonly systemPrompt?: string | undefined;
	readonly tools?: ReadonlyArray<PiPrefixTool> | undefined;
	readonly estimateTokens?: EstimateTextTokens | undefined;
}): ResolvedPiContextUsage {
	const contextWindow =
		positiveNumber(input.live?.contextWindow) ?? positiveNumber(input.contextWindow);
	const liveTokens = input.live?.tokens;

	if (typeof liveTokens === "number" && liveTokens > 0) {
		return {
			tokens: liveTokens,
			percent: resolvePercent(input.live?.percent, liveTokens, contextWindow),
			contextWindow,
			source: "live",
			prefix: EMPTY_PREFIX,
		};
	}

	const prefix =
		input.systemPrompt !== undefined || input.tools !== undefined
			? estimatePiPrefixTokens({
					...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
					...(input.tools !== undefined ? { tools: input.tools } : {}),
					...(input.estimateTokens !== undefined ? { estimateTokens: input.estimateTokens } : {}),
				})
			: EMPTY_PREFIX;
	const prefixTokens = Math.max(0, input.prefixTokens ?? prefix.tokens);

	if (typeof liveTokens === "number") {
		if (prefixTokens > 0) {
			return {
				tokens: prefixTokens,
				percent: percentOf(prefixTokens, contextWindow),
				contextWindow,
				source: "prefix",
				prefix,
			};
		}
		return {
			tokens: 0,
			percent: resolvePercent(input.live?.percent, 0, contextWindow),
			contextWindow,
			source: "live",
			prefix,
		};
	}

	return {
		tokens: undefined,
		percent: undefined,
		contextWindow,
		source: "unknown",
		prefix,
	};
}

const EMPTY_PREFIX: PiPrefixTokens = {
	systemPromptTokens: 0,
	toolDefinitionTokens: 0,
	tokens: 0,
};

function resolvePercent(
	livePercent: number | null | undefined,
	tokens: number,
	contextWindow: number | undefined,
): number | undefined {
	if (typeof livePercent === "number") return livePercent;
	return percentOf(tokens, contextWindow);
}

function percentOf(tokens: number, contextWindow: number | undefined): number | undefined {
	if (contextWindow === undefined || contextWindow <= 0) return undefined;
	return (tokens / contextWindow) * 100;
}

function positiveNumber(value: number | null | undefined): number | undefined {
	return typeof value === "number" && value > 0 ? value : undefined;
}

function safeStringify(value: unknown): string {
	try {
		if (value === undefined || value === null) return "";
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return "";
	}
}
