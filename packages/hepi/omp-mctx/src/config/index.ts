import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	createJsonFlatSectionSettingsStorage,
	getRuntimeSettingsRegistry,
	type SettingField,
	type SettingsProvider,
	type SettingsState,
	type SettingValue,
} from "#host/pi-ext-shim";
import {
	DEFAULT_LOCAL_EMBEDDING_MODEL,
	type MagicContextConfig,
	MagicContextConfigSchema,
} from "#core/config/schema/magic-context";
import { setOutputReserveConfig } from "#core/shared/models-dev-cache";

export const PI_MCTX_SETTINGS_SECTION = "pi-mctx";
export const PI_MCTX_SETTINGS_GROUP = "operational";

const ENABLED_FIELD = "enabled";
const COMPACTION_ENABLED_FIELD = "compactionEnabled";
const SYSTEM_PROMPT_INJECTION_FIELD = "systemPromptInjection";
const TEMPORAL_AWARENESS_FIELD = "temporalAwareness";
const MEMORY_ENABLED_FIELD = "memoryEnabled";
const SEARCH_ENABLED_FIELD = "searchEnabled";
const NOTE_ENABLED_FIELD = "noteEnabled";
const MEMORY_INJECTION_BUDGET_FIELD = "memoryInjectionBudgetTokens";
const MEMORY_AUTO_PROMOTE_FIELD = "memoryAutoPromote";
const MEMORY_RETRIEVAL_PROMOTION_THRESHOLD_FIELD = "memoryRetrievalPromotionThreshold";
const MEMORY_AUTO_SEARCH_ENABLED_FIELD = "memoryAutoSearchEnabled";
const MEMORY_AUTO_SEARCH_SCORE_THRESHOLD_FIELD = "memoryAutoSearchScoreThreshold";
const MEMORY_AUTO_SEARCH_MIN_PROMPT_CHARS_FIELD = "memoryAutoSearchMinPromptChars";
const MEMORY_GIT_COMMIT_INDEXING_ENABLED_FIELD = "memoryGitCommitIndexingEnabled";
const MEMORY_GIT_COMMIT_SINCE_DAYS_FIELD = "memoryGitCommitSinceDays";
const MEMORY_GIT_COMMIT_MAX_COMMITS_FIELD = "memoryGitCommitMaxCommits";
const HISTORIAN_ENABLED_FIELD = "historianEnabled";
const HISTORIAN_MODEL_FIELD = "historianModel";
const HISTORIAN_TWO_PASS_FIELD = "historianTwoPass";
const HISTORIAN_TIMEOUT_FIELD = "historianTimeoutMs";
const HISTORY_BUDGET_FIELD = "historyBudgetPercentage";
const COMMIT_CLUSTER_TRIGGER_ENABLED_FIELD = "commitClusterTriggerEnabled";
const COMMIT_CLUSTER_MIN_CLUSTERS_FIELD = "commitClusterMinClusters";
const DREAMER_ENABLED_FIELD = "dreamerEnabled";
const DREAMER_MODEL_FIELD = "dreamerModel";
const DREAMER_INJECT_DOCS_FIELD = "dreamerInjectDocs";
const SIDEKICK_MODEL_FIELD = "sidekickModel";
const EMBEDDING_PROVIDER_FIELD = "embeddingProvider";
const EMBEDDING_MODEL_FIELD = "embeddingModel";
const EMBEDDING_ENDPOINT_FIELD = "embeddingEndpoint";
const EMBEDDING_API_KEY_ENV_FIELD = "embeddingApiKeyEnv";

const DEFAULT_CONFIG = MagicContextConfigSchema.parse({});
let bootConfig: MagicContextConfig | undefined;

function parseBoolean(draft: string): boolean {
	const normalized = draft.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	throw new Error('Enter "true" or "false".');
}

function booleanField(args: {
	id: string;
	label: string;
	defaultValue: boolean;
	description: string;
}): SettingField<boolean> {
	return { ...args, type: "boolean", parse: parseBoolean };
}

function numberField(args: {
	id: string;
	label: string;
	defaultValue: number;
	description: string;
	minimum: number;
	maximum?: number | undefined;
}): SettingField<number> {
	return {
		...args,
		type: "number",
		parse: (draft) => {
			const value = Number(draft.trim());
			if (!Number.isFinite(value)) throw new Error("Enter a number.");
			return value;
		},
		validate: (value) => {
			if (value < args.minimum) return `Enter a value of at least ${args.minimum}.`;
			if (args.maximum !== undefined && value > args.maximum)
				return `Enter a value no greater than ${args.maximum}.`;
			return undefined;
		},
	};
}

function textField(args: {
	id: string;
	label: string;
	defaultValue?: string | undefined;
	description: string;
}): SettingField<string> {
	return {
		...args,
		defaultValue: args.defaultValue ?? "",
		type: "text",
		parse: (draft) => draft.trim(),
	};
}

function environmentVariableField(args: {
	id: string;
	label: string;
	description: string;
}): SettingField<string> {
	return {
		...textField(args),
		validate: (value) =>
			value === "" || /^[A-Z_][A-Z0-9_]*$/.test(value)
				? undefined
				: "Enter an uppercase environment variable name.",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSettingValue(value: unknown): value is SettingValue {
	return (
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string" ||
		value === null ||
		(Array.isArray(value) && value.every((entry) => typeof entry === "string"))
	);
}

function settingValue(state: SettingsState, field: string): unknown {
	return state[PI_MCTX_SETTINGS_GROUP]?.[field];
}

function settingBoolean(state: SettingsState, field: string, fallback: boolean): boolean {
	const value = settingValue(state, field);
	return typeof value === "boolean" ? value : fallback;
}

function settingText(state: SettingsState, field: string): string | undefined {
	const value = settingValue(state, field);
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function settingNumber(
	state: SettingsState,
	field: string,
	fallback: number,
	minimum: number,
	maximum?: number,
): number {
	const value = settingValue(state, field);
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= minimum &&
		(maximum === undefined || value <= maximum)
		? value
		: fallback;
}

export interface PiMctxToolSettings {
	searchEnabled: boolean;
	noteEnabled: boolean;
}

/** Tool registration is boot-resolved because Pi registers tools once per process. */
export function resolvePiMctxToolSettings(raw: Record<string, unknown>): PiMctxToolSettings {
	const state = pluginSettingsToState(raw);
	return {
		searchEnabled: settingBoolean(state, SEARCH_ENABLED_FIELD, true),
		noteEnabled: settingBoolean(state, NOTE_ENABLED_FIELD, true),
	};
}

/** Converts flat ext-core settings into the Pi MCTX runtime schema. */
export function resolvePiMctxSettings(state: SettingsState = {}): MagicContextConfig {
	const memory = DEFAULT_CONFIG.memory;
	// OMP owns only the Window by default. Durable Memory is an explicit opt-in
	// because @hheei/omp-agentmemory is the selected durable-memory owner.
	const memoryEnabled = settingBoolean(state, MEMORY_ENABLED_FIELD, false);
	const historianEnabled = settingBoolean(
		state,
		HISTORIAN_ENABLED_FIELD,
		DEFAULT_CONFIG.historian?.disable !== true,
	);
	const dreamerEnabled = settingBoolean(
		state,
		DREAMER_ENABLED_FIELD,
		DEFAULT_CONFIG.dreamer !== undefined && DEFAULT_CONFIG.dreamer.disable !== true,
	);
	const historianModel = settingText(state, HISTORIAN_MODEL_FIELD);
	const dreamerModel = settingText(state, DREAMER_MODEL_FIELD);
	const sidekickModel = settingText(state, SIDEKICK_MODEL_FIELD);
	const embeddingProvider = settingText(state, EMBEDDING_PROVIDER_FIELD);
	const embeddingModel = settingText(state, EMBEDDING_MODEL_FIELD);
	const embeddingEndpoint = settingText(state, EMBEDDING_ENDPOINT_FIELD);
	const embeddingApiKeyEnv = settingText(state, EMBEDDING_API_KEY_ENV_FIELD);
	const embeddingApiKey =
		embeddingApiKeyEnv && /^[A-Z_][A-Z0-9_]*$/.test(embeddingApiKeyEnv)
			? process.env[embeddingApiKeyEnv]
			: undefined;
	const embedding =
		embeddingProvider === "off"
			? { provider: "off" as const }
			: embeddingProvider === "openai-compatible" && embeddingModel && embeddingEndpoint
				? {
						provider: "openai-compatible" as const,
						model: embeddingModel,
						endpoint: embeddingEndpoint,
						...(embeddingApiKey ? { api_key: embeddingApiKey } : {}),
					}
				: embeddingProvider === "local"
					? {
							provider: "local" as const,
							model: embeddingModel ?? DEFAULT_LOCAL_EMBEDDING_MODEL,
						}
					: DEFAULT_CONFIG.embedding;

	return MagicContextConfigSchema.parse({
		enabled: settingBoolean(state, ENABLED_FIELD, DEFAULT_CONFIG.enabled),
		compaction: {
			...DEFAULT_CONFIG.compaction,
			enabled: settingBoolean(state, COMPACTION_ENABLED_FIELD, DEFAULT_CONFIG.compaction.enabled),
		},
		system_prompt_injection: {
			...DEFAULT_CONFIG.system_prompt_injection,
			enabled: settingBoolean(
				state,
				SYSTEM_PROMPT_INJECTION_FIELD,
				DEFAULT_CONFIG.system_prompt_injection.enabled,
			),
		},
		temporal_awareness: settingBoolean(
			state,
			TEMPORAL_AWARENESS_FIELD,
			DEFAULT_CONFIG.temporal_awareness,
		),
		history_budget_percentage: settingNumber(
			state,
			HISTORY_BUDGET_FIELD,
			DEFAULT_CONFIG.history_budget_percentage,
			0.05,
			0.5,
		),
		historian_timeout_ms: settingNumber(
			state,
			HISTORIAN_TIMEOUT_FIELD,
			DEFAULT_CONFIG.historian_timeout_ms,
			60_000,
		),
		commit_cluster_trigger: {
			...DEFAULT_CONFIG.commit_cluster_trigger,
			enabled: settingBoolean(
				state,
				COMMIT_CLUSTER_TRIGGER_ENABLED_FIELD,
				DEFAULT_CONFIG.commit_cluster_trigger.enabled,
			),
			min_clusters: settingNumber(
				state,
				COMMIT_CLUSTER_MIN_CLUSTERS_FIELD,
				DEFAULT_CONFIG.commit_cluster_trigger.min_clusters,
				1,
			),
		},
		historian: {
			...(DEFAULT_CONFIG.historian ?? {}),
			disable: !historianEnabled,
			...(historianModel ? { model: historianModel } : {}),
			two_pass: settingBoolean(
				state,
				HISTORIAN_TWO_PASS_FIELD,
				DEFAULT_CONFIG.historian?.two_pass ?? false,
			),
		},
		memory: {
			...memory,
			enabled: memoryEnabled,
			// These long-term-memory adjuncts must never activate independently
			// of the enclosing feature gate.
			auto_promote: memoryEnabled
				? settingBoolean(state, MEMORY_AUTO_PROMOTE_FIELD, memory.auto_promote)
				: false,
			retrieval_count_promotion_threshold: settingNumber(
				state,
				MEMORY_RETRIEVAL_PROMOTION_THRESHOLD_FIELD,
				memory.retrieval_count_promotion_threshold,
				1,
			),
			auto_search: {
				...memory.auto_search,
				enabled:
					memoryEnabled &&
					settingBoolean(
						state,
						MEMORY_AUTO_SEARCH_ENABLED_FIELD,
						memory.auto_search.enabled,
					),
				score_threshold: settingNumber(
					state,
					MEMORY_AUTO_SEARCH_SCORE_THRESHOLD_FIELD,
					memory.auto_search.score_threshold,
					0.3,
					0.95,
				),
				min_prompt_chars: settingNumber(
					state,
					MEMORY_AUTO_SEARCH_MIN_PROMPT_CHARS_FIELD,
					memory.auto_search.min_prompt_chars,
					5,
					500,
				),
			},
			git_commit_indexing: {
				...memory.git_commit_indexing,
				enabled:
					memoryEnabled &&
					settingBoolean(
						state,
						MEMORY_GIT_COMMIT_INDEXING_ENABLED_FIELD,
						memory.git_commit_indexing.enabled,
					),
				since_days: settingNumber(
					state,
					MEMORY_GIT_COMMIT_SINCE_DAYS_FIELD,
					memory.git_commit_indexing.since_days,
					7,
					3650,
				),
				max_commits: settingNumber(
					state,
					MEMORY_GIT_COMMIT_MAX_COMMITS_FIELD,
					memory.git_commit_indexing.max_commits,
					100,
					20_000,
				),
			},
		},
		embedding,
		dreamer: dreamerEnabled
			? {
					...(dreamerModel ? { model: dreamerModel } : {}),
					inject_docs: settingBoolean(
						state,
						DREAMER_INJECT_DOCS_FIELD,
						DEFAULT_CONFIG.dreamer?.inject_docs ?? true,
					),
				}
			: undefined,
		...(sidekickModel ? { sidekick: { model: sidekickModel } } : {}),
	});
}

function pluginSettingsToState(raw: Record<string, unknown>): SettingsState {
	const operational: Record<string, SettingValue | undefined> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (isSettingValue(value)) operational[key] = value;
	}
	return { [PI_MCTX_SETTINGS_GROUP]: operational };
}

export function primePiMctxConfigFromPluginSettings(raw: Record<string, unknown>): void {
	bootConfig = resolvePiMctxSettings(pluginSettingsToState(raw));
	setOutputReserveConfig(bootConfig.output_reserve);
}

/** Schema defaults, or the last primed OMP plugin settings snapshot. */
export function loadPiConfig(): MagicContextConfig {
	if (bootConfig !== undefined) return bootConfig;
	bootConfig = resolvePiMctxSettings({});
	setOutputReserveConfig(bootConfig.output_reserve);
	return bootConfig;
}

/** Replaces the boot snapshot when Pi re-evaluates this extension on `/reload`. */
export function resetPiMctxConfigForReload(): void {
	bootConfig = undefined;
}

export function createPiMctxSettingsProvider(): SettingsProvider {
	const memory = { ...DEFAULT_CONFIG.memory, enabled: false };
	const historianEnabled = DEFAULT_CONFIG.historian?.disable !== true;
	const dreamerEnabled =
		DEFAULT_CONFIG.dreamer !== undefined && DEFAULT_CONFIG.dreamer.disable !== true;
	return {
		id: PI_MCTX_SETTINGS_SECTION,
		title: "Magic Context",
		moduleName: "pi-mctx",
		description: "Operational Magic Context controls. Changes apply after /reload or restart.",
		groups: [
			{
				id: PI_MCTX_SETTINGS_GROUP,
				title: "Operational",
				description: "Global Pi MCTX controls applied at the next extension boot.",
				fields: [
					booleanField({
						id: ENABLED_FIELD,
						label: "enabled",
						defaultValue: DEFAULT_CONFIG.enabled,
						description:
							"Enable Magic Context commands, tools, widgets, and lifecycle handlers after reload.",
					}),
					booleanField({
						id: COMPACTION_ENABLED_FIELD,
						label: "compaction",
						defaultValue: DEFAULT_CONFIG.compaction.enabled,
						description:
							"Enable Magic Context compaction instead of leaving context management to native Pi.",
					}),
					booleanField({
						id: SYSTEM_PROMPT_INJECTION_FIELD,
						label: "system prompt injection",
						defaultValue: DEFAULT_CONFIG.system_prompt_injection.enabled,
						description:
							"Inject Magic Context instructions into supported agent system prompts after reload.",
					}),
					booleanField({
						id: TEMPORAL_AWARENESS_FIELD,
						label: "temporal awareness",
						defaultValue: DEFAULT_CONFIG.temporal_awareness,
						description: "Inject elapsed-time and date markers into context after the next reload.",
					}),
					booleanField({
						id: MEMORY_ENABLED_FIELD,
						label: "memory",
						defaultValue: memory.enabled,
						description:
							"Opt in to omp-mctx's legacy durable-memory store. Off keeps Window tools only and leaves durable memory to omp-agentmemory.",
					}),
					booleanField({
						id: SEARCH_ENABLED_FIELD,
						label: "ctx search",
						defaultValue: true,
						description:
							"Register ctx_search for session-history retrieval after reload. Disable to remove it from the agent tool surface.",
					}),
					booleanField({
						id: NOTE_ENABLED_FIELD,
						label: "ctx note",
						defaultValue: true,
						description:
							"Register ctx_note and session-note nudges after reload. Disable to remove both.",
					}),
					numberField({
						id: MEMORY_INJECTION_BUDGET_FIELD,
						label: "memory injection budget",
						defaultValue: memory.injection_budget_tokens,
						description: "Reserve tokens for memory injection after the next reload.",
						minimum: 500,
						maximum: 20_000,
					}),
					booleanField({
						id: MEMORY_AUTO_PROMOTE_FIELD,
						label: "memory auto promote",
						defaultValue: memory.auto_promote,
						description: "Promote eligible session observations into durable memory after reload.",
					}),
					numberField({
						id: MEMORY_RETRIEVAL_PROMOTION_THRESHOLD_FIELD,
						label: "memory promotion retrievals",
						defaultValue: memory.retrieval_count_promotion_threshold,
						description: "Require this many retrievals before memory promotion after reload.",
						minimum: 1,
					}),
					booleanField({
						id: MEMORY_AUTO_SEARCH_ENABLED_FIELD,
						label: "memory auto search",
						defaultValue: memory.auto_search.enabled,
						description:
							"Add related-memory search hints to eligible user prompts after the next reload.",
					}),
					numberField({
						id: MEMORY_AUTO_SEARCH_SCORE_THRESHOLD_FIELD,
						label: "memory search score",
						defaultValue: memory.auto_search.score_threshold,
						description: "Require this top search score before showing a memory hint after reload.",
						minimum: 0.3,
						maximum: 0.95,
					}),
					numberField({
						id: MEMORY_AUTO_SEARCH_MIN_PROMPT_CHARS_FIELD,
						label: "memory search prompt length",
						defaultValue: memory.auto_search.min_prompt_chars,
						description: "Skip memory search hints below this prompt length after reload.",
						minimum: 5,
						maximum: 500,
					}),
					booleanField({
						id: MEMORY_GIT_COMMIT_INDEXING_ENABLED_FIELD,
						label: "git commit indexing",
						defaultValue: memory.git_commit_indexing.enabled,
						description: "Index project Git commits as a ctx_search source after reload.",
					}),
					numberField({
						id: MEMORY_GIT_COMMIT_SINCE_DAYS_FIELD,
						label: "git history days",
						defaultValue: memory.git_commit_indexing.since_days,
						description: "Index this many days of Git history after the next reload.",
						minimum: 7,
						maximum: 3650,
					}),
					numberField({
						id: MEMORY_GIT_COMMIT_MAX_COMMITS_FIELD,
						label: "git commit limit",
						defaultValue: memory.git_commit_indexing.max_commits,
						description: "Keep at most this many indexed Git commits per project after reload.",
						minimum: 100,
						maximum: 20_000,
					}),
					booleanField({
						id: HISTORIAN_ENABLED_FIELD,
						label: "historian",
						defaultValue: historianEnabled,
						description: "Enable historian runs that prepare and summarize long session context.",
					}),
					textField({
						id: HISTORIAN_MODEL_FIELD,
						label: "historian model",
						description:
							"Pi provider/model ID for historian runs, for example github-copilot/gpt-5.4. Leave empty to disable historian calls.",
					}),
					booleanField({
						id: HISTORIAN_TWO_PASS_FIELD,
						label: "historian two pass",
						defaultValue: DEFAULT_CONFIG.historian?.two_pass ?? false,
						description: "Run a second historian cleanup pass after the primary pass.",
					}),
					numberField({
						id: HISTORIAN_TIMEOUT_FIELD,
						label: "historian timeout",
						defaultValue: DEFAULT_CONFIG.historian_timeout_ms,
						description: "Allow this many milliseconds for each historian prompt call.",
						minimum: 60_000,
					}),
					numberField({
						id: HISTORY_BUDGET_FIELD,
						label: "history budget",
						defaultValue: DEFAULT_CONFIG.history_budget_percentage,
						description: "Reserve this fraction of usable context for the historian history block.",
						minimum: 0.05,
						maximum: 0.5,
					}),
					booleanField({
						id: COMMIT_CLUSTER_TRIGGER_ENABLED_FIELD,
						label: "commit cluster trigger",
						defaultValue: DEFAULT_CONFIG.commit_cluster_trigger.enabled,
						description: "Trigger historian runs when unsummarized Git clusters accumulate.",
					}),
					numberField({
						id: COMMIT_CLUSTER_MIN_CLUSTERS_FIELD,
						label: "commit clusters",
						defaultValue: DEFAULT_CONFIG.commit_cluster_trigger.min_clusters,
						description: "Require this many commit clusters before triggering historian work.",
						minimum: 1,
					}),
					booleanField({
						id: DREAMER_ENABLED_FIELD,
						label: "dreamer",
						defaultValue: dreamerEnabled,
						description: "Enable Dreamer background tasks using canonical default schedules.",
					}),
					textField({
						id: DREAMER_MODEL_FIELD,
						label: "dreamer model",
						description:
							"Pi provider/model ID for Dreamer tasks. Leave empty to use existing task session-model fallback where available.",
					}),
					booleanField({
						id: DREAMER_INJECT_DOCS_FIELD,
						label: "dreamer project docs",
						defaultValue: DEFAULT_CONFIG.dreamer?.inject_docs ?? true,
						description: "Inject project documentation into Dreamer task prompts after reload.",
					}),
					textField({
						id: SIDEKICK_MODEL_FIELD,
						label: "sidekick model",
						description:
							"Pi provider/model ID for sidekick retrieval runs. Leave empty to disable sidekick calls.",
					}),
					textField({
						id: EMBEDDING_PROVIDER_FIELD,
						label: "embedding provider",
						defaultValue: DEFAULT_CONFIG.embedding.provider,
						description: "Embedding backend: local, openai-compatible, or off.",
					}),
					textField({
						id: EMBEDDING_MODEL_FIELD,
						label: "embedding model",
						defaultValue:
							DEFAULT_CONFIG.embedding.provider === "local" ? DEFAULT_CONFIG.embedding.model : "",
						description:
							"Local or remote embedding model ID. Remote mode requires this value and an endpoint.",
					}),
					textField({
						id: EMBEDDING_ENDPOINT_FIELD,
						label: "embedding endpoint",
						description: "OpenAI-compatible embedding API endpoint. Applies only in remote mode.",
					}),
					environmentVariableField({
						id: EMBEDDING_API_KEY_ENV_FIELD,
						label: "embedding API key env",
						description:
							"Environment variable containing the remote embedding API key. The key itself is never saved in Pi settings.",
					}),
				],
			},
		],
		storage: createJsonFlatSectionSettingsStorage({
			section: PI_MCTX_SETTINGS_SECTION,
			group: PI_MCTX_SETTINGS_GROUP,
		}),
	};
}

/** OMP uses plugin settings, not the Pi settings.json UI. */
export function registerPiMctxSettings(_pi: ExtensionAPI): () => void {
	return () => {};
}
