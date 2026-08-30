import { isSaneLimit, resolveLimit } from "#core/shared/models-dev-cache";

export interface PiModelLimit {
	provider?: string | undefined;
	id?: string | undefined;
	contextWindow?: number | null | undefined;
	maxTokens?: number | null | undefined;
}
export function resolvePiUsableContextLimit(args: {
	rawContextWindow: number | null | undefined;
	model?: PiModelLimit | undefined;
	detectedContextLimit?: number | undefined;
}): number | undefined {
	const rawContext = isSaneLimit(args.rawContextWindow) ? args.rawContextWindow : undefined;
	const detected =
		typeof args.detectedContextLimit === "number" &&
		Number.isFinite(args.detectedContextLimit) &&
		args.detectedContextLimit >= 1024
			? args.detectedContextLimit
			: undefined;
	const context =
		rawContext !== undefined && detected !== undefined
			? Math.min(rawContext, detected)
			: (rawContext ?? detected);
	if (context === undefined) return undefined;
	const output = args.model?.maxTokens;
	return resolveLimit(
		{
			context,
			...(typeof output === "number" ? { output } : {}),
		},
		args.model?.provider ?? "unknown",
		args.model?.id ?? "unknown",
	);
}
