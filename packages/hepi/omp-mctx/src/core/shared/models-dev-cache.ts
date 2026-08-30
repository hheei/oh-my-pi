import { piModelRefToCanonical } from "./harness-provider-map";
import { sessionLog } from "./logger";

/** Pi model limits come from the active runtime model, not a host provider API. */
export const MIN_SANE_LIMIT = 20_000;
export const MAX_SANE_LIMIT = 3_000_000;

export function isSaneLimit(limit: number | null | undefined): limit is number {
	return typeof limit === "number" && limit >= MIN_SANE_LIMIT && limit <= MAX_SANE_LIMIT;
}

export type OutputReserveConfig = number | { default: number; [modelKey: string]: number };

export interface ModelLimit {
	context?: number | undefined;
	input?: number | undefined;
	output?: number | undefined;
}

const SEPARATE_OUTPUT_QUOTA_PROVIDERS = new Set(["google", "google-antigravity"]);
const MIN_PLAUSIBLE_CONTEXT_LIMIT = 1024;
const OUTPUT_RESERVE_CAP_RATIO = 0.25;
let outputReserveConfig: OutputReserveConfig | undefined;
const reserveClampLogSeen = new Set<string>();

function isFinitePositive(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function modelKeyLookupOrder(providerID: string, modelID: string): string[] {
	const full = `${providerID}/${modelID}`;
	const canonicalFull = piModelRefToCanonical(full);
	const candidates = [full, canonicalFull, modelID];
	const colon = modelID.lastIndexOf(":");
	if (colon > 0) {
		const bareModel = modelID.slice(0, colon);
		const providerBare = `${providerID}/${bareModel}`;
		candidates.push(providerBare, piModelRefToCanonical(providerBare), bareModel);
	}
	return [...new Set(candidates)];
}

function configuredOutputReserve(
	config: OutputReserveConfig | undefined,
	providerID: string,
	modelID: string,
): number | undefined {
	if (typeof config === "number")
		return Number.isFinite(config) && config >= 0 ? config : undefined;
	if (!config) return undefined;
	for (const candidate of modelKeyLookupOrder(providerID, modelID)) {
		const value = config[candidate];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
	return Number.isFinite(config.default) && config.default >= 0 ? config.default : undefined;
}

function logReserveClampOnce(key: string, message: string): void {
	if (reserveClampLogSeen.has(key)) return;
	reserveClampLogSeen.add(key);
	sessionLog("global", `model-limit: ${message}`);
}

export function setOutputReserveConfig(config: OutputReserveConfig | undefined): void {
	outputReserveConfig = config;
}

export function resolveLimit(
	limit: ModelLimit | undefined,
	providerID: string,
	modelID: string,
	reserveConfig: OutputReserveConfig | undefined = outputReserveConfig,
): number | undefined {
	if (!limit) return undefined;
	const context = isFinitePositive(limit.context) ? limit.context : undefined;
	const input = isFinitePositive(limit.input) ? limit.input : undefined;
	if (input !== undefined && (context === undefined || input < context)) return input;
	if (context === undefined) return undefined;

	const configuredReserve = configuredOutputReserve(reserveConfig, providerID, modelID);
	let reserve: number;
	if (configuredReserve !== undefined) {
		reserve = configuredReserve;
	} else if (SEPARATE_OUTPUT_QUOTA_PROVIDERS.has(providerID)) {
		reserve = 0;
	} else {
		const output = isFinitePositive(limit.output) ? limit.output : 0;
		const cap = context * OUTPUT_RESERVE_CAP_RATIO;
		reserve = Math.min(output, cap);
		if (output > cap) {
			logReserveClampOnce(
				`cap|${providerID}/${modelID}|${context}|${output}`,
				`output reserve capped at 25% for ${providerID}/${modelID}: ${output} -> ${cap}`,
			);
		}
	}

	const floor = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, context * 0.5);
	const maxReserve = Math.max(0, context - floor);
	if (reserve > maxReserve) {
		logReserveClampOnce(
			`floor|${providerID}/${modelID}|${context}|${reserve}`,
			`output reserve clamped for ${providerID}/${modelID}: ${reserve} -> ${maxReserve} (usable floor ${floor})`,
		);
		reserve = maxReserve;
	}
	return Math.floor(context - reserve);
}

/** Core callers have no catalog fallback; Pi supplies its model window directly. */
export function getSdkContextLimit(): undefined {
	return undefined;
}

export function getSdkInputLimit(): undefined {
	return undefined;
}

export function modelSupportsVision(): false {
	return false;
}

export function clearModelsDevCache(): void {}

export function resetAuthRewarmLatchForTest(): void {}

export function getModelsDevCacheState(): {
	apiLoaded: boolean;
	apiCount: number;
	apiAgeMs: number;
} {
	return { apiLoaded: false, apiCount: 0, apiAgeMs: -1 };
}
