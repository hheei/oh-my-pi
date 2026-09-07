/** Settings for the mctx-owned agentmemory bridge.
 *
 * The bridge deliberately has its own gate.  `memoryEnabled` belongs to the
 * legacy mctx store and must not turn this integration on as a side effect.
 */

export const DEFAULT_AGENTMEMORY_URL = "http://127.0.0.1:3111";

export interface AgentMemoryBridgeSettings {
	enabled: boolean;
	url: string;
	secret: string;
	project: string;
	agentId?: string;
	capture: boolean;
	inject: boolean;
	historianRetrieval: boolean;
	memoryTools: boolean;
	requireHttps: boolean;
}

export interface AgentMemorySettingsEnvironment {
	AGENTMEMORY_URL?: string;
	AGENTMEMORY_SECRET?: string;
	AGENTMEMORY_PROJECT_NAME?: string;
	AGENT_ID?: string;
	AGENTMEMORY_REQUIRE_HTTPS?: string;
}

const EMPTY_SETTINGS: AgentMemoryBridgeSettings = {
	enabled: false,
	url: DEFAULT_AGENTMEMORY_URL,
	secret: "",
	project: "",
	capture: true,
	inject: true,
	historianRetrieval: true,
	memoryTools: true,
	requireHttps: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = value.trim();
	return result.length > 0 ? result : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function settingValue(raw: Record<string, unknown>, nested: Record<string, unknown>, key: string): unknown {
	// Dotted keys are the canonical OMP plugin setting spelling.  The camel
	// aliases keep project-local settings written by earlier preview builds
	// readable, while the nested shape is useful to SDK callers and tests.
	const camel = `agentmemory${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`;
	// Never read the top-level plugin setting here. In particular, the
	// Window's `enabled` flag must not implicitly enable this independent
	// bridge.
	return nested[key] ?? raw[`agentmemory.${key}`] ?? raw[camel];
}

export function resolveAgentMemorySettings(
	raw: Record<string, unknown> = {},
	environment: AgentMemorySettingsEnvironment = process.env as AgentMemorySettingsEnvironment,
): AgentMemoryBridgeSettings {
	const nested = isRecord(raw.agentmemory) ? raw.agentmemory : {};
	const enabled = booleanValue(settingValue(raw, nested, "enabled"), EMPTY_SETTINGS.enabled);
	const capture = booleanValue(settingValue(raw, nested, "capture"), EMPTY_SETTINGS.capture);
	const inject = booleanValue(settingValue(raw, nested, "inject"), EMPTY_SETTINGS.inject);
	const historianRetrieval = booleanValue(
		settingValue(raw, nested, "historianRetrieval"),
		EMPTY_SETTINGS.historianRetrieval,
	);
	const memoryTools = booleanValue(settingValue(raw, nested, "memoryTools"), EMPTY_SETTINGS.memoryTools);
	const requireHttps = booleanValue(
		settingValue(raw, nested, "requireHttps"),
		environment.AGENTMEMORY_REQUIRE_HTTPS === "1",
	);
	const configuredUrl = nonEmptyString(settingValue(raw, nested, "url"));
	const configuredSecret = nonEmptyString(settingValue(raw, nested, "secret"));
	const configuredProject = nonEmptyString(settingValue(raw, nested, "project"));
	const configuredAgentId = nonEmptyString(settingValue(raw, nested, "agentId"));

	return {
		enabled,
		url: nonEmptyString(environment.AGENTMEMORY_URL) ?? configuredUrl ?? EMPTY_SETTINGS.url,
		secret: nonEmptyString(environment.AGENTMEMORY_SECRET) ?? configuredSecret ?? "",
		project: nonEmptyString(environment.AGENTMEMORY_PROJECT_NAME) ?? configuredProject ?? "",
		agentId: nonEmptyString(environment.AGENT_ID) ?? configuredAgentId,
		capture,
		inject,
		historianRetrieval,
		memoryTools,
		requireHttps,
	};
}

let bootSettings: AgentMemoryBridgeSettings | undefined;

/** Snapshot plugin settings before the extension runtime is started. */
export function primeAgentMemorySettings(raw: Record<string, unknown>): void {
	bootSettings = resolveAgentMemorySettings(raw);
}

/** Return the boot snapshot, or safe defaults when used outside the host. */
export function loadAgentMemorySettings(): AgentMemoryBridgeSettings {
	if (bootSettings !== undefined) return bootSettings;
	bootSettings = resolveAgentMemorySettings({});
	return bootSettings;
}

export function resetAgentMemorySettingsForReload(): void {
	bootSettings = undefined;
}
