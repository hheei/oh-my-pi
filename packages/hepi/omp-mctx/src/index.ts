/**
 * Magic Context — Pi coding agent extension.
 *
 * Loaded once per Pi session by the Pi extension bootstrap.
 * Registers session lifecycle hooks: tools, transform pipeline (tagging + drops),
 * historian trigger, /ctx-aug command, system-prompt injection, Dreamer scheduling,
 * and agent_end cleanup.
 *
 * Storage: fresh Pi schema at
 *   ${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-mctx/context.db
 *
 * Config: direct global Pi `settings.json` fields under `pi-mctx`, registered through
 * `#host/pi-ext-shim`. Settings changes apply on `/reload` or restart.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import type { ExtensionAPI, MessageRenderer } from "@oh-my-pi/pi-coding-agent";
import { Box, Text } from "@oh-my-pi/pi-tui";
import { isCompactionEnabled, isDreamerRunnable } from "#core/config/agent-disable";
import type {
	DreamerConfig,
	HistorianConfig,
	MagicContextConfig,
	SidekickConfig,
} from "#core/config/schema/magic-context";
import {
	summarizeDreamSchedule,
	userMemoryCollectionEnabled,
} from "#core/features/dreamer/task-config";
import {
	type FailClosedReason,
	formatFailClosedBlockingMessage,
} from "#core/features/fail-closed-block";
import { resolveProjectIdentityForSession } from "#core/features/memory/project-identity";
import { scheduleIncrementalIndex } from "#core/features/message-index-async";
import { detectOverflow } from "#core/features/overflow-detection";
import { runSessionProjectBackfill } from "#core/features/session-project-backfill";
import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	getPendingPiCompactionMarkerState,
	getSessionsWithPendingPiMarker,
	updateSessionMeta,
} from "#core/features/storage";

import {
	applySqliteTuningPragmas,
	openDatabaseAsync,
	setSqlitePragmaConfig,
} from "#core/features/storage-db";
import { getOverflowState, recordOverflowDetected } from "#core/features/storage-meta-persisted";
import { setCtxReduceRegisteredGlobally } from "#core/hooks/ctx-reduce-availability";
import {
	deriveHistorianChunkTokens,
	resolveHistorianContextLimit,
} from "#core/hooks/derive-budgets";
import { resolveCacheTtl } from "#core/hooks/event-resolvers";
import { clearNoteNudgeTriggerAndCooldown } from "#core/hooks/note-nudger";
import { maybeSendUpgradeReminder } from "#core/hooks/upgrade-reminder";
import { beginBootQuietPeriod, scheduleAfterBootQuiet } from "#core/plugin/boot-quiet";
import {
	ANNOUNCEMENT_FEATURES,
	ANNOUNCEMENT_FOOTER,
	ANNOUNCEMENT_VERSION,
	markAnnouncementSeen,
	shouldShowAnnouncement,
} from "#core/shared/announcement";
import { getMagicContextStorageDir } from "#core/shared/data-path";
import { setHarness } from "#core/shared/harness";
import { setKeepSubagents } from "#core/shared/keep-subagents";
import { log } from "#core/shared/logger";
import { resolveFallbackChain } from "#core/shared/resolve-fallbacks";
import { setStoragePrivatePermissionEnforcement } from "#core/shared/storage-permissions";

import { handlePiCloneSessionStart } from "./clone-inheritance";
import { type PiSidekickConfig, registerCtxAugCommand } from "./commands/ctx-aug";
import { registerCtxDreamCommand } from "./commands/ctx-dream";
import { maybeAutoEmbedPiSession, registerCtxEmbedCommand } from "./commands/ctx-embed";
import { registerCtxFlushCommand } from "./commands/ctx-flush";
import { registerCtxRecompCommand } from "./commands/ctx-recomp";
import { registerCtxSessionUpgradeCommand } from "./commands/ctx-session-upgrade";
import { registerCtxStatusCommand } from "./commands/ctx-status";
import { registerCtxWrapupCommand } from "./commands/ctx-wrapup";
import { registerCtxStatusEntryRenderer, sendCtxStatusMessage } from "./commands/pi-command-utils";
import {
	loadPiConfig,
	primePiMctxConfigFromPluginSettings,
	resetPiMctxConfigForReload,
	resolvePiMctxToolSettings,
	type PiMctxToolSettings,
} from "./config";
import { loadOmpMctxPluginSettings, shouldStartOmpMctx } from "./host/settings";
import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	clearPiM0Cache,
	clearSystemPromptRefresh,
	hasSystemPromptRefresh,
	type PiAutoSearchHandlerOptions,
	type PiContextHandlerOptions,
	type PiHistorianOptions,
	recordPiLiveModel,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
	signalPiSystemPromptRefreshForProject,
	trackSessionForProject,
} from "./context-handler";
import { asPromptParts, asPromptText, undefNum } from "./host/omp";
import {
	advancePiChannel1Turn,
	CHANNEL1_NUDGE_CUSTOM_TYPE,
	CHANNEL2_NUDGE_CUSTOM_TYPE,
	type Channel1NudgeMessageDetails,
	markChannel1ReminderDelivered,
	markPiChannel1Reduced,
	maybeChannel1ReminderForToolResult,
	maybeDeliverChannel2Pi,
} from "./ctx-reduce-nudge-pi";
import {
	awaitInFlightDreamers,
	registerPiDreamerProject,
	unregisterPiDreamerProject,
} from "./dreamer";
import { loadDefaultPiSessionApi } from "./dreamer/pi-session-api";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { registerPiFailClosedSurface } from "./fail-closed-pi";
import { applyHandoffAuthorityGuard, branchHasHandoffContext } from "./host/handoff-guard";
import { resolvePiUsableContextLimit } from "./pi-context-limit";
import { awaitInFlightRecomps } from "./pi-recomp-runner";
import { computePiPressure, extractAssistantUsage } from "./pi-pressure";
import { annotateEmptyTaskOutputContent } from "./core/hooks/empty-task-output";
import { readPiSessionMessages } from "./read-session-pi";
import { registerStatusLine, updateStatusLine } from "./status-line";
import {
	configurePiSubagentExtensions,
	MAGIC_CONTEXT_PI_SUBAGENT_ENV,
	PiSubagentRunner,
} from "./subagent-runner";
import {
	buildMagicContextBlock,
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import { withTimeout } from "./timeout";
import { registerMagicContextTools } from "./tools";

const PREFIX = "[magic-context][pi]";

export const renderChannel1Nudge: MessageRenderer<Channel1NudgeMessageDetails> = (
	message,
	_options,
	theme,
) => {
	const text = message.details?.displayText;
	if (typeof text !== "string") return undefined;
	const box = new Box(1, 0, (content) => theme.bg("customMessageBg", content));
	box.addChild(
		new Text(
			`${theme.bold(theme.fg("accent", "[magic context]"))}\n${theme.fg("customMessageText", text)}`,
		),
	);
	return box;
};

// ---------------------------------------------------------------------------
// Process-global init latch (issue #247)
//
// `@gotgenes/pi-subagents` runs child agent sessions IN-PROCESS inside the
// parent Pi process. Each child inherits the parent's user packages, so Pi
// re-imports and re-runs this extension factory for every child session. The
// existing recursion guard (`MAGIC_CONTEXT_PI_SUBAGENT=1`) only covers
// SPAWNED subprocess children because in-process children share the parent's
// env without that variable. Without a process-wide signal, every in-process
// child re-ran the full Magic Context init — opening the DB, wiring timers /
// watchers / event handlers, and scheduling background session scans. Four
// parallel children fanned out concurrent `SessionManager.listAll` scans over
// ~392 JSONL sessions and crashed the parent with heap OOM.
//
// The latch below is a `Symbol.for` key on `globalThis` so it survives the
// duplicate module instances Pi's jiti loader creates per session
// (`moduleCache: false` resets module-level state on every re-import, but a
// Symbol.for key is process-global). The first init in this process sets it;
// every later init in the same process (in-process child, or a second factory
// call from any source) sees it set and no-ops with the SAME contract as a
// spawned subagent child — no watchers, no timers, no background scans. The
// parent's already-registered extension instance keeps serving its session.
//
// Dispose / re-arm: Pi fires `session_shutdown` (reason "reload") before a
// `/reload` re-imports extensions, and (reason "shutdown") when the user
// leaves the session. Each AgentSession owns its own ExtensionRunner, so a
// child session's `session_shutdown` only fires handlers the CHILD registered
// (none, because the child no-op'd) — it cannot clear the parent's latch.
// We clear the latch in the parent's `session_shutdown` handler so a `/reload`
// legitimately re-initializes, while ephemeral in-process children never touch
// it.
// ---------------------------------------------------------------------------
const PI_ACTIVE_LATCH = Symbol.for("magic-context.pi.active");

function isPiMagicContextActiveInProcess(): boolean {
	return (globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH] === true;
}

function markPiMagicContextActive(): void {
	(globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH] = true;
}

function clearPiMagicContextActive(): void {
	try {
		delete (globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH];
	} catch {
		// Some runtimes disallow delete on globalThis; fall back to overwrite.
		(globalThis as Record<symbol, unknown>)[PI_ACTIVE_LATCH] = undefined;
	}
}

function resolveCurrentProject(
	ctx: { cwd: string },
	allowHomeProject = false,
): {
	projectDir: string;
	projectIdentity: string;
} {
	const projectDir = ctx.cwd;
	const projectIdentity = resolveProjectIdentityForSession(projectDir, allowHomeProject) ?? "";
	return { projectDir, projectIdentity };
}

export function signalPiDeferredCompactionMarkerDrain(sessionId: string): void {
	signalPiDeferredHistoryRefresh(sessionId);
	signalPiDeferredMaterialization(sessionId);
}

/**
 * Pi native compaction invalidates MC's cached m[0]/m[1] bytes. In normal mode
 * MC still owns compaction and cancels this event; compaction-off mode clears
 * only that cache and deliberately returns no cancellation result.
 */
export async function handlePiSessionBeforeCompact(args: {
	db: ContextDatabase;
	compactionOff: boolean;
	ctx: { sessionManager?: { getSessionId?: () => string | undefined } };
}): Promise<{ cancel: true } | undefined> {
	try {
		const sessionId = args.ctx.sessionManager?.getSessionId?.();
		if (typeof sessionId === "string" && sessionId.length > 0) {
			clearPiM0Cache(args.db, sessionId, "session_before_compact");
		}
	} catch {
		// Cache invalidation is best-effort; it must not suppress Pi's native path.
	}
	if (args.compactionOff) {
		info("session_before_compact: native Pi compaction proceeds (compaction-off mode)");
		return;
	}
	info("session_before_compact: cancelling — magic-context owns compaction");
	return { cancel: true };
}

export function persistPiMessageEndModelMeta(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	cacheTtlConfig: MagicContextConfig["cache_ttl"];
}): void {
	if (!args.message || typeof args.message !== "object") return;
	const msg = args.message as {
		role?: string | undefined;
		provider?: string | undefined;
		model?: string | undefined;
	};
	if (
		msg.role !== "assistant" ||
		typeof msg.provider !== "string" ||
		msg.provider.length === 0 ||
		typeof msg.model !== "string" ||
		msg.model.length === 0
	) {
		return;
	}
	const modelKey = `${msg.provider}/${msg.model}`;
	recordPiLiveModel(args.sessionId, modelKey);
	const cacheTtl = resolveCacheTtl(args.cacheTtlConfig, modelKey);
	const currentMeta = getOrCreateSessionMeta(args.db, args.sessionId);
	if (currentMeta.cacheTtl !== cacheTtl) {
		updateSessionMeta(args.db, args.sessionId, { cacheTtl });
	}
}

function info(message: string, data?: unknown): void {
	log(`${PREFIX} ${message}`, data);
}

function warn(message: string, data?: unknown): void {
	log(`${PREFIX} WARN ${message}`, data);
}

export const __test = {
	isPiMagicContextActiveInProcess,
	markPiMagicContextActive,
	clearPiMagicContextActive,
};

function appendHandoffAuthorityGuard(
	systemPrompt: string,
	ctx: { sessionManager?: { getEntries?: () => unknown[] } },
): string {
	return applyHandoffAuthorityGuard(systemPrompt, branchHasHandoffContext(ctx));
}

function formatTokens(value: number): string {
	return value.toLocaleString();
}

function getPiMessageModel(message: unknown): {
	provider: string | undefined;
	model: string | undefined;
} {
	if (!message || typeof message !== "object") {
		return { provider: undefined, model: undefined };
	}
	const msg = message as { provider?: unknown; model?: unknown };
	return {
		provider: typeof msg.provider === "string" ? msg.provider : undefined,
		model: typeof msg.model === "string" ? msg.model : undefined,
	};
}

function resolvePiPressureContextLimit(args: {
	db: ContextDatabase;
	sessionId: string;
	piContextWindow: number;
	model?:
		| { provider?: string | undefined; id?: string | undefined; maxTokens?: number | undefined }
		| undefined;
}): number {
	// Pi reports the model's context window directly (ctx.getContextUsage() /
	// ctx.model.contextWindow) — its own authoritative source. We no longer
	// consult models.dev for Pi. Sanity-bound the reported value so a transient
	// garbage window can't poison pressure (mirrors legacy host's SDK sane bound).
	let detectedContextLimit: number | undefined;
	try {
		const overflowState = getOverflowState(args.db, args.sessionId);
		if (overflowState.detectedContextLimit > 0) {
			detectedContextLimit = overflowState.detectedContextLimit;
		}
	} catch (err) {
		warn("message_end: getOverflowState failed:", err);
	}
	return (
		resolvePiUsableContextLimit({
			rawContextWindow: args.piContextWindow,
			model: args.model,
			detectedContextLimit,
		}) ?? 0
	);
}

export async function persistPiPressureFromMessageEnd(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	piContextWindow: number;
	piModel?:
		| { provider?: string | undefined; id?: string | undefined; maxTokens?: number | undefined }
		| undefined;
	piTokens?: number | undefined;
	notifyIssue?: ((message: string) => unknown | Promise<unknown>) | undefined;
}): Promise<void> {
	const { provider, model } = getPiMessageModel(args.message);
	const effectiveContextLimit = resolvePiPressureContextLimit({
		db: args.db,
		sessionId: args.sessionId,
		piContextWindow: args.piContextWindow,
		model: args.piModel ?? { provider, id: model },
	});
	const usage = extractAssistantUsage(args.message);
	const pressure = computePiPressure(usage, effectiveContextLimit);
	const msg =
		args.message && typeof args.message === "object"
			? (args.message as { errorMessage?: unknown })
			: undefined;
	const messageHadOverflowError =
		typeof msg?.errorMessage === "string" && detectOverflow(msg.errorMessage).isOverflow;
	const updates: Partial<{
		lastResponseTime: number;
		lastContextPercentage: number;
		lastInputTokens: number;
		observedSafeInputTokens: number;
		cacheAlertSent: boolean;
	}> = { lastResponseTime: Date.now() };

	if (pressure) {
		const percentage = pressure.percentage;
		const contextLimit = effectiveContextLimit;
		const meta = getOrCreateSessionMeta(args.db, args.sessionId);
		const observedSafeInputTokens = meta.observedSafeInputTokens ?? 0;
		if (
			percentage > 100 &&
			observedSafeInputTokens > 0 &&
			pressure.inputTokens <= observedSafeInputTokens * 2
		) {
			// Pi resolves the window from its own runtime, not a cache we could
			// reload — so a >100% reading with a known-good safe baseline means
			// Pi's reported contextWindow is genuinely wrong. There's nothing to
			// re-fetch; surface the alert (overflow detection still captures a
			// real lower cap separately).
			if (!meta.cacheAlertSent) {
				updates.cacheAlertSent = true;
				const safeTokens = Math.max(observedSafeInputTokens, pressure.inputTokens);
				const modelLabel = provider && model ? `${provider}/${model}` : "the active model";
				await args.notifyIssue?.(
					`⚠️ Magic Context: Pi reports a context limit of ${formatTokens(contextLimit)} tokens for ${modelLabel} but you've successfully sent ${formatTokens(safeTokens)} tokens in this session — the reported limit looks wrong. Restart Pi if you suspect this is incorrect.`,
				);
			}
		}
		updates.lastContextPercentage = percentage;
		updates.lastInputTokens = pressure.inputTokens;
		if (!messageHadOverflowError) {
			updates.observedSafeInputTokens = Math.max(observedSafeInputTokens, pressure.inputTokens);
		}
	} else if (typeof args.piTokens === "number") {
		updates.lastInputTokens = args.piTokens;
		if (effectiveContextLimit > 0) {
			updates.lastContextPercentage = (args.piTokens / effectiveContextLimit) * 100;
		}
	}

	updateSessionMeta(args.db, args.sessionId, updates);
}

/** Plugin version from package.json. */
const PLUGIN_VERSION: string = (() => {
	try {
		const req = createRequire(import.meta.url);
		return (req("../package.json") as { version: string }).version;
	} catch {
		return "0.0.0";
	}
})();

/** Lock the harness at module load. Safe to import this file in tests; the
 * lock is idempotent and will throw only on a conflicting reset. */
setHarness("pi");

// ---------------------------------------------------------------------------
// Config-driven resolvers
//
// Pi MCTX reads one validated global `pi-mctx` snapshot through
// ext-core at extension boot. `/reload` is the explicit configuration boundary;
// resolvers below adapt that schema-shaped snapshot into Pi-specific options.
//
// Each resolver returns `undefined` when the relevant feature is disabled
// in config, so the registration helpers can short-circuit cleanly.
// ---------------------------------------------------------------------------

export function resolveSidekickFromConfig(
	config: MagicContextConfig,
): PiSidekickConfig | undefined {
	const sidekick = config.sidekick as SidekickConfig | undefined;
	if (!sidekick || sidekick.disable === true) return undefined;
	const model = sidekick.model?.trim();
	if (!model || model.length === 0) return undefined;
	return {
		model,
		systemPrompt: sidekick.system_prompt,
		timeoutMs: sidekick.timeout_ms,
		thinking_level: sidekick.thinking_level,
		fallbackModels: resolveFallbackChain(sidekick.fallback_models),
		language: config.language,
		allowHomeProject: config.allow_home_project,
	};
}

export function resolveHistorianFromConfig(
	config: MagicContextConfig,
): PiHistorianOptions | undefined {
	// Defensive: schema declares `historian` required with default {}, but the
	// runtime config can come from a malformed JSONC merge that drops the
	// field. Fall back to undefined-safe access so plugin load never crashes.
	const historian = config.historian as HistorianConfig | undefined;
	if (historian?.disable === true) return undefined;
	const model = historian?.model?.trim();
	if (!model || model.length === 0) return undefined;

	// The historian chunk budget is anchored to the HISTORIAN model because
	// it bounds one summarizer call. The trigger budget is intentionally NOT
	// derived at startup: Pi resolves it per context pass from the live main
	// session model + effective execute threshold to match legacy host.
	const historianContextLimit = resolveHistorianContextLimit(model);
	const historianChunkTokens = deriveHistorianChunkTokens(historianContextLimit);

	const fallbackModels = resolveFallbackChain(historian?.fallback_models);

	return {
		runner: new PiSubagentRunner(),
		model,
		fallbackModels,
		historianChunkTokens,
		timeoutMs: config.historian_timeout_ms,
		// `historian.two_pass` runs an editor pass after a successful
		// first pass to clean low-signal U: lines and cross-compartment
		// duplicates. Mirrors legacy host's config flag — defaults to false
		// on the schema side because the editor pass adds a second
		// historian round-trip's latency and token cost. Enable for
		// long sessions where chunk dedupe matters more than speed.
		twoPass: historian?.two_pass === true,
		// Pi only: explicit thinking level for historian subagent invocations.
		// When set, passed as --thinking <level> to Pi subprocess.
		// Required for providers like GitHub Copilot that apply bad defaults.
		thinkingLevel: historian?.thinking_level,
		executeThresholdPercentage: config.execute_threshold_percentage,
		executeThresholdTokens: config.execute_threshold_tokens,
		commitClusterTrigger: config.commit_cluster_trigger,
		protectedTags: config.protected_tags,
		clearReasoningAge: config.clear_reasoning_age,
		historyBudgetPercentage: config.history_budget_percentage,
		memoryEnabled: config.memory.enabled,
		autoPromote: config.memory.auto_promote,
		userMemoriesEnabled: userMemoryCollectionEnabled(config.dreamer),
		language: config.language,
		allowHomeProject: config.allow_home_project,
	};
}

function resolveAutoSearchFromConfig(config: MagicContextConfig): PiAutoSearchHandlerOptions {
	const auto = config.memory.auto_search;
	return {
		enabled: config.memory.enabled && (auto?.enabled ?? false),
		scoreThreshold: auto?.score_threshold ?? 0.55,
		minPromptChars: auto?.min_prompt_chars ?? 20,
	};
}

export function resolveDreamerFromConfig(config: MagicContextConfig): DreamerConfig | undefined {
	return config.dreamer?.disable === true ? undefined : config.dreamer;
}

/**
 * Pi extension default export. Called once per Pi session.
 *
 * Registers the full Magic Context Pi runtime: tools, transform pipeline
 * (tagging + drops), historian trigger, nudges, auto-search hint,
 * /ctx-aug command, system-prompt injection, and dreamer scheduling.
 * All driven by the user's Pi MCTX settings in `/ext-settings`.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
	if (process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] === "1") {
		log(
			`${PREFIX} subagent child detected (${MAGIC_CONTEXT_PI_SUBAGENT_ENV}=1); skipping full extension registration`,
		);
		return;
	}
	// In-process child guard (issue #247): `@gotgenes/pi-subagents` runs child
	// agent sessions in the SAME process as the parent. They share the parent's
	// env (so the spawned-child env guard above never fires) and re-trigger this
	// factory for every child session. The process-global latch marks that the
	// full Magic Context runtime is already active in this process; a second
	// init no-ops with the same contract as a spawned subagent (no watchers, no
	// timers, no background scans). The parent's registered instance keeps
	// serving. See the latch block above for the dispose / `/reload` re-arm path.
	if (isPiMagicContextActiveInProcess()) {
		log(
			`${PREFIX} in-process re-init detected (Magic Context already active in this process); skipping full extension registration`,
		);
		return;
	}
	const pluginSettings = await loadOmpMctxPluginSettings(process.cwd());
	if (!shouldStartOmpMctx(pluginSettings)) {
		log(`${PREFIX} plugin setting enabled=false; skipping Window runtime`);
		return;
	}
	markPiMagicContextActive();
	beginBootQuietPeriod();
	resetPiMctxConfigForReload();
	primePiMctxConfigFromPluginSettings(pluginSettings);
	const bootConfig = loadPiConfig();
	const toolSettings = resolvePiMctxToolSettings(pluginSettings);
	setStoragePrivatePermissionEnforcement(bootConfig.storage.enforce_private_permissions);
	setSqlitePragmaConfig({
		cacheSizeMb: bootConfig.sqlite.cache_size_mb,
		mmapSizeMb: bootConfig.sqlite.mmap_size_mb,
	});

	const storageDir = getMagicContextStorageDir();
	const dbPath = join(storageDir, "context.db");

	let db: ContextDatabase | null | undefined;
	let openFailureCause: string | null = null;
	try {
		db = await openDatabaseAsync({ memoryEnabled: bootConfig.memory.enabled });
	} catch (err) {
		openFailureCause = err instanceof Error ? err.message : String(err);
		db = null;
	}

	// Storage open failures are fatal for this runtime. The fresh-schema
	// initializer rejects legacy databases before it writes anything.
	if (!db) {
		if (!bootConfig.enabled) {
			info("plugin DISABLED via config (enabled: false) — skipping registration");
			return;
		}
		const reason: FailClosedReason = {
			kind: "storage_failure",
			cause: openFailureCause ?? `storage unavailable at ${dbPath}`,
		};
		if (bootConfig.fail_closed_blocking === false || !isCompactionEnabled(bootConfig)) {
			warn(
				`Magic Context (pi) storage unavailable at ${dbPath}: ${formatFailClosedBlockingMessage(reason)}. ` +
					"fail_closed_blocking=false — degrading silently (hooks not registered).",
			);
			return;
		}
		warn(
			`Magic Context (pi) storage unavailable at ${dbPath}: ${formatFailClosedBlockingMessage(reason)}`,
		);
		let fullRuntimeStarted = false;
		registerPiFailClosedSurface(pi, {
			reason,
			tryReopen: async () => {
				try {
					return await openDatabaseAsync({ memoryEnabled: bootConfig.memory.enabled });
				} catch {
					return null;
				}
			},
			onRecovered: async (recoveredDb) => {
				if (fullRuntimeStarted) return;
				fullRuntimeStarted = true;
				await startPiMagicContextRuntime(pi, recoveredDb, dbPath, bootConfig, toolSettings);
			},
		});
		return;
	}

	await startPiMagicContextRuntime(pi, db, dbPath, bootConfig, toolSettings);
}

/**
 * Full Magic Context registration after a successful storage open.
 * Extracted so a healed re-probe from the fail-closed surface can start the
 * runtime without requiring a process restart.
 */
async function startPiMagicContextRuntime(
	pi: ExtensionAPI,
	database: ContextDatabase,
	dbPath: string,
	config: MagicContextConfig,
	toolSettings: PiMctxToolSettings,
): Promise<void> {
	const db = database;
	pi.registerMessageRenderer(CHANNEL1_NUDGE_CUSTOM_TYPE, renderChannel1Nudge);
	pi.registerMessageRenderer(CHANNEL2_NUDGE_CUSTOM_TYPE, renderChannel1Nudge);

	scheduleAfterBootQuiet(() => {
		void (async () => {
			try {
				const api = await loadDefaultPiSessionApi();
				const sessions = (await api.listSessions()) as Array<{
					id?: unknown | undefined;
					cwd?: unknown | undefined;
				}>;
				await runSessionProjectBackfill(
					database,
					sessions.map((session) => ({
						sessionId: typeof session?.id === "string" ? session.id : "",
						directory: typeof session?.cwd === "string" ? session.cwd : "",
					})),
				);
			} catch (err) {
				warn(`[session-projects] background runner failed: ${err}`);
			}
		})();
	}, 0);

	// Root config is global and immutable for this runtime. `/cd` changes only
	// project identity; `/reload` is required to apply persisted settings.
	const projectDir = process.cwd();
	const seenDreamerProjectIdentities = new Set<string>();
	const projectIdentity =
		resolveProjectIdentityForSession(projectDir, config.allow_home_project) ?? "";
	if (projectIdentity) seenDreamerProjectIdentities.add(projectIdentity);
	info(
		`loaded v${PLUGIN_VERSION} | harness=pi | db=${dbPath} | ` +
			`project=${projectIdentity} | dir=${projectDir}`,
	);
	// Pi tools are registered once per process, so this mode is intentionally
	// boot-resolved rather than following later /cd project config changes.
	const compactionOff = !isCompactionEnabled(config);
	setCtxReduceRegisteredGlobally(!compactionOff);
	if (!compactionOff) {
		try {
			const pendingPiMarkerSessions = getSessionsWithPendingPiMarker(db);
			for (const sid of pendingPiMarkerSessions) {
				signalPiDeferredCompactionMarkerDrain(sid);
			}
			if (pendingPiMarkerSessions.length > 0) {
				log(
					`${PREFIX} rehydrated ${pendingPiMarkerSessions.length} Pi deferred compaction marker session(s)`,
				);
			}
		} catch (err) {
			warn(
				`Magic Context (pi) failed to rehydrate deferred Pi compaction markers: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	// The child extension allowlist is global Pi settings, resolved once per boot.
	configurePiSubagentExtensions(config.pi?.subagent_extensions);

	// Reapply boot-resolved storage and SQLite settings before runtime registration.
	// Cache and mmap pragmas take effect live; later opens inherit this snapshot.
	setStoragePrivatePermissionEnforcement(config.storage.enforce_private_permissions);
	setSqlitePragmaConfig({
		cacheSizeMb: config.sqlite.cache_size_mb,
		mmapSizeMb: config.sqlite.mmap_size_mb,
	});
	applySqliteTuningPragmas(db);

	// Debug data-collection toggle: keep subagent child sessions instead of
	// deleting on success (parity with the legacy host plugin).
	setKeepSubagents(config.keep_subagents === true);

	// Top-level disable: when `enabled: false` is set in config, register
	// nothing — same fail-closed posture the legacy host plugin uses.
	if (!config.enabled) {
		info("plugin DISABLED via config (enabled: false) — skipping registration");
		return;
	}

	if (config.memory.enabled) {
		await ensureProjectRegisteredFromPiDirectory(projectDir, db);
		info(
			`registered embedding config for project ${projectIdentity ?? "(no project identity; cwd is $HOME)"}`,
		);
	} else {
		info("legacy durable memory: DISABLED");
	}

	type ResolvedPiProjectDeps = {
		projectDir: string;
		projectIdentity: string;
		config: MagicContextConfig;
		historianConfig: PiHistorianOptions | undefined;
		autoSearchConfig: PiAutoSearchHandlerOptions;
		contextOptions: PiContextHandlerOptions;
		sidekickConfig: PiSidekickConfig | undefined;
		dreamerConfig: DreamerConfig | undefined;
		dreamerEnabled: boolean;
	};

	// Per-cwd runtime deps. Pi can switch projects mid-process (`/cd`,
	// multi-root), while tools and slash commands are registered only once.
	// Resolve all project-sensitive config through this memoized accessor so
	// every invocation reads the active cwd's config instead of the launch cwd's.
	const projectDepsByDir = new Map<string, ResolvedPiProjectDeps>();

	const buildContextOptions = (
		cfg: MagicContextConfig,
		hist: PiHistorianOptions | undefined,
		auto: PiAutoSearchHandlerOptions,
	): PiContextHandlerOptions => ({
		db: database,
		smartDrops: cfg.smart_drops === true,
		protectedTags: cfg.protected_tags ?? 20,
		heuristics: {
			caveman: cfg.caveman_text_compression
				? {
						enabled: cfg.caveman_text_compression.enabled,
						minChars: cfg.caveman_text_compression.min_chars,
					}
				: undefined,
			clearReasoningAge: cfg.clear_reasoning_age,
		},
		injection: {
			memoryEnabled: cfg.memory.enabled,
			injectDocs: cfg.dreamer?.inject_docs !== false,
			injectionBudgetTokens: cfg.memory.injection_budget_tokens,
			temporalAwareness: cfg.temporal_awareness === true,
			muralEnabled: cfg.experimental?.mural?.enabled === true,
		},
		scheduler: {
			executeThresholdPercentage: cfg.execute_threshold_percentage,
			executeThresholdTokens: cfg.execute_threshold_tokens,
		},
		historian: hist,
		language: cfg.language,
		autoSearch: auto,
		noteNudgesEnabled: toolSettings.noteEnabled,
		resolveForProject: resolveContextOptionsForProject,
		compactionOff,
		allowHomeProject: cfg.allow_home_project,
		maybeAutoEmbedSession: (sessionId, dir, identity) => {
			maybeAutoEmbedPiSession(
				{
					db: database,
					projectDir: dir,
					projectIdentity: identity,
					memoryEnabled: cfg.memory.enabled,
				},
				sessionId,
				dir,
				identity,
				(text) => {
					sendCtxStatusMessage(pi, {
						title: "/ctx-embed",
						text,
						level: "info",
					});
				},
			);
		},
	});

	function buildProjectDeps(
		dir: string,
		identity: string,
		cfg: MagicContextConfig,
	): ResolvedPiProjectDeps {
		const hist = resolveHistorianFromConfig(cfg);
		if (hist) {
			hist.onStatusChange = (ctx) => {
				updateStatusLine(ctx, {
					db: database,
					projectIdentity: resolveCurrentProject(ctx, cfg.allow_home_project).projectIdentity ?? "",
				});
			};
		}
		const auto = resolveAutoSearchFromConfig(cfg);
		return {
			projectDir: dir,
			projectIdentity: identity,
			config: cfg,
			historianConfig: hist,
			autoSearchConfig: auto,
			contextOptions: buildContextOptions(cfg, hist, auto),
			sidekickConfig: resolveSidekickFromConfig(cfg),
			dreamerConfig: resolveDreamerFromConfig(cfg),
			dreamerEnabled: isDreamerRunnable(cfg),
		};
	}

	function resolveProjectDepsForDir(dir: string, identityOverride?: string): ResolvedPiProjectDeps {
		const cached = projectDepsByDir.get(dir);
		if (cached) return cached;
		const switchedConfig = config;
		const switchedIdentity =
			identityOverride ??
			resolveProjectIdentityForSession(dir, switchedConfig.allow_home_project) ??
			"";
		const built = buildProjectDeps(dir, switchedIdentity, switchedConfig);
		projectDepsByDir.set(dir, built);
		return built;
	}

	function resolveCurrentProjectDeps(ctx: { cwd: string }): ResolvedPiProjectDeps {
		return resolveProjectDepsForDir(ctx.cwd);
	}

	function resolveContextOptionsForProject(dir: string): PiContextHandlerOptions {
		return resolveProjectDepsForDir(dir).contextOptions;
	}

	const bootProjectDeps = buildProjectDeps(projectDir, projectIdentity, config);
	projectDepsByDir.set(projectDir, bootProjectDeps);

	// Register the agent-facing tools. Business logic is shared with the
	// HEPI core, but persistence is this plugin's own `context.db` under
	// `~/.omp/agent/extensions/omp-mctx/`.
	registerMagicContextTools(pi, {
		db,
		ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
		// Each agent-facing tool has an explicit boot-time gate. `ctx_expand`
		// and `ctx_reduce` remain the Window's core controls.
		allowDreamerActions: false,
		searchToolEnabled: toolSettings.searchEnabled,
		noteToolEnabled: toolSettings.noteEnabled,
		memoryToolEnabled: config.memory.enabled,
		memoryEnabled: config.memory.enabled,
		embeddingEnabled: config.memory.enabled && config.embedding.provider !== "off",
		gitCommitsEnabled: config.memory.enabled && config.memory.git_commit_indexing.enabled,
		protectedTags: config.protected_tags ?? 20,
		resolveProtectedTags: (ctx) => resolveCurrentProjectDeps(ctx).config.protected_tags ?? 20,
		resolveProjectIdentity: (ctx) => resolveCurrentProjectDeps(ctx).projectIdentity,
		// Smart notes (surface_condition) only work when dreamer is
		// running — otherwise the note sits `pending` forever with no
		// path to surface. Match the user's dreamer config flag.
		dreamerEnabled: isDreamerRunnable(config),
		resolveDreamerEnabled: (ctx) => resolveCurrentProjectDeps(ctx).dreamerEnabled,
		compactionOff,
	});
	const registeredTools = ["ctx_expand"];
	if (toolSettings.searchEnabled) registeredTools.unshift("ctx_search");
	if (toolSettings.noteEnabled) registeredTools.push("ctx_note");
	if (config.memory.enabled) registeredTools.push("ctx_memory");
	if (!compactionOff) registeredTools.push("ctx_reduce");
	info(`registered tools: ${registeredTools.join(", ")}`);

	pi.on("session_switch", async (event, ctx) => {
		await handlePiCloneSessionStart(
			{ reason: event.reason, previousSessionFile: event.previousSessionFile },
			ctx,
			{
				db,
				signalPendingMarker: signalPiDeferredCompactionMarkerDrain,
			},
		);
	});

	// Register the per-LLM-call transform pipeline. Tags eligible message
	// parts via the shared Tagger and applies queued drops from
	// `pending_ops` so /ctx-flush and ctx_reduce work against Pi sessions.
	registerPiContextHandler(pi, bootProjectDeps.contextOptions);
	info(
		bootProjectDeps.historianConfig
			? `registered historian trigger (model=${bootProjectDeps.historianConfig.model}, executeThreshold=${formatExecuteThresholdForLog(bootProjectDeps.historianConfig.executeThresholdPercentage)})`
			: "registered historian trigger: DISABLED (set the historian model in /ext-settings)",
	);
	info(
		bootProjectDeps.autoSearchConfig.enabled
			? `registered auto-search hint (threshold=${bootProjectDeps.autoSearchConfig.scoreThreshold}, minChars=${bootProjectDeps.autoSearchConfig.minPromptChars})`
			: "registered auto-search hint: DISABLED (memory.auto_search.enabled=false)",
	);

	// Register /ctx-aug once, but resolve sidekick config from the active cwd
	// every invocation so `/cd` follows the current project's model/language.
	registerCtxAugCommand(pi, (ctx) => resolveCurrentProjectDeps(ctx).sidekickConfig);
	info(
		bootProjectDeps.sidekickConfig
			? `registered /ctx-aug (sidekick model=${bootProjectDeps.sidekickConfig.model})`
			: "registered /ctx-aug (sidekick disabled — set sidekick.disable=false and sidekick.model in config)",
	);

	// Register the shared renderer before any command can append a status entry.
	// Plain custom entries render in interactive Pi without entering model context.
	const statusEntryRendererAvailable = registerCtxStatusEntryRenderer(pi);
	info(
		statusEntryRendererAvailable
			? "registered model-invisible ctx-status entry renderer"
			: "ctx-status entry renderer unavailable; using legacy visible-message fallback",
	);

	// Step 5c: register the diagnostic/admin slash commands so Pi reaches
	// command-surface parity with the legacy host plugin. Their user-facing output
	// uses model-invisible custom entries when the runtime can render them.
	const recompRunner = new PiSubagentRunner();
	const wrapupRunner = new PiSubagentRunner();
	const upgradeRunner = new PiSubagentRunner();
	registerCtxStatusCommand(pi, {
		db,
		projectIdentity,
		resolveProject: resolveCurrentProject,
		protectedTags: bootProjectDeps.config.protected_tags,
		executeThresholdPercentage: bootProjectDeps.config.execute_threshold_percentage,
		historyBudgetPercentage: bootProjectDeps.config.history_budget_percentage,
		injectionBudgetTokens: bootProjectDeps.config.memory?.injection_budget_tokens,
		commitClusterTrigger: bootProjectDeps.config.commit_cluster_trigger,
		executeThresholdTokens: bootProjectDeps.config.execute_threshold_tokens,
		dreamer: {
			runnable: bootProjectDeps.dreamerEnabled,
			scheduleSummary: summarizeDreamSchedule(bootProjectDeps.config.dreamer),
		},
		resolveStatusDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				projectIdentity: current.projectIdentity,
				protectedTags: current.config.protected_tags,
				executeThresholdPercentage: current.config.execute_threshold_percentage,
				historyBudgetPercentage: current.config.history_budget_percentage,
				injectionBudgetTokens: current.config.memory?.injection_budget_tokens,
				commitClusterTrigger: current.config.commit_cluster_trigger,
				executeThresholdTokens: current.config.execute_threshold_tokens,
				dreamer: {
					runnable: current.dreamerEnabled,
					scheduleSummary: summarizeDreamSchedule(current.config.dreamer),
				},
			};
		},
	});
	info("registered /ctx-status");
	registerStatusLine(pi, { db, projectIdentity });
	info("registered magic-context status line");

	registerCtxFlushCommand(pi, { db, compactionOff });
	info("registered /ctx-flush");

	// /ctx-recomp uses its own PiSubagentRunner instance — recomp can run
	// concurrently with normal historian, and giving each its own runner
	// avoids cross-cancellation. Same model + fallback chain as historian.
	registerCtxRecompCommand(pi, {
		db,
		runner: recompRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		autoPromote: bootProjectDeps.config.memory.auto_promote,
		compactionOff,
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: recompRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				autoPromote: current.config.memory.auto_promote,
				compactionOff,
			};
		},
	});
	info("registered /ctx-recomp");

	registerCtxWrapupCommand(pi, {
		db,
		runner: wrapupRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		autoPromote: bootProjectDeps.config.memory.auto_promote,
		compactionOff,
		userMemoriesEnabled: userMemoryCollectionEnabled(bootProjectDeps.config.dreamer),
		executeThresholdPercentage: bootProjectDeps.config.execute_threshold_percentage,
		executeThresholdTokens: bootProjectDeps.config.execute_threshold_tokens,
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: wrapupRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				autoPromote: current.config.memory.auto_promote,
				compactionOff,
				userMemoriesEnabled: userMemoryCollectionEnabled(current.config.dreamer),
				executeThresholdPercentage: current.config.execute_threshold_percentage,
				executeThresholdTokens: current.config.execute_threshold_tokens,
			};
		},
	});
	info("registered /ctx-wrapup");
	info("skipped /handoff (not ported to omp-mctx)");


	// E6b/E6c: /ctx-session-upgrade — full recomp (legacy→v2 tiered) + once-per-
	// project memory migration into the 5-category taxonomy. Own runner instance
	// for the same isolation reasons as /ctx-recomp.
	registerCtxSessionUpgradeCommand(pi, {
		db,
		runner: upgradeRunner,
		historianModel: bootProjectDeps.historianConfig?.model,
		historianChunkTokens: deriveHistorianChunkTokens(
			resolveHistorianContextLimit(bootProjectDeps.historianConfig?.model),
		),
		historianFallbacks: bootProjectDeps.historianConfig?.fallbackModels,
		historianTimeoutMs: bootProjectDeps.config.historian_timeout_ms,
		historianThinkingLevel: bootProjectDeps.historianConfig?.thinkingLevel,
		language: bootProjectDeps.config.language,
		memoryEnabled: bootProjectDeps.config.memory.enabled,
		allowHomeProject: bootProjectDeps.config.allow_home_project,
		autoPromote: bootProjectDeps.config.memory.auto_promote,
		compactionOff,
		userMemoriesEnabled: userMemoryCollectionEnabled(bootProjectDeps.config.dreamer),
		resolveRuntimeDeps: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				db,
				runner: upgradeRunner,
				historianModel: current.historianConfig?.model,
				historianChunkTokens: deriveHistorianChunkTokens(
					resolveHistorianContextLimit(current.historianConfig?.model),
				),
				historianFallbacks: current.historianConfig?.fallbackModels,
				historianTimeoutMs: current.config.historian_timeout_ms,
				historianThinkingLevel: current.historianConfig?.thinkingLevel,
				language: current.config.language,
				memoryEnabled: current.config.memory.enabled,
				allowHomeProject: current.config.allow_home_project,
				autoPromote: current.config.memory.auto_promote,
				compactionOff,
				userMemoriesEnabled: userMemoryCollectionEnabled(current.config.dreamer),
			};
		},
	});
	info("registered /ctx-session-upgrade");

	registerCtxDreamCommand(pi, {
		db,
		projectDir,
		projectIdentity,
		resolveProject: (ctx) => {
			const current = resolveCurrentProjectDeps(ctx);
			return {
				projectDir: current.projectDir,
				projectIdentity: current.projectIdentity,
			};
		},
		dreamerEnabled: bootProjectDeps.dreamerEnabled,
		resolveDreamerEnabled: (ctx) => resolveCurrentProjectDeps(ctx).dreamerEnabled,
		onProjectSeen: (identity) => seenDreamerProjectIdentities.add(identity),
	});
	info("registered /ctx-dream");

	if (config.memory.enabled) {
		registerCtxEmbedCommand(pi, {
			db,
			projectDir,
			projectIdentity,
			memoryEnabled: true,
			resolveMemoryEnabled: (ctx) => resolveCurrentProjectDeps(ctx).config.memory.enabled,
			resolveProject: (ctx) => {
				const current = resolveCurrentProjectDeps(ctx);
				return {
					projectDir: current.projectDir,
					projectIdentity: current.projectIdentity,
				};
			},
		});
		info("registered /ctx-embed");
	} else {
		info("registered /ctx-embed: DISABLED (legacy durable memory off)");
	}

	// Register Pi project with the singleton dreamer timer. When dreamer is
	// disabled in config (default) this is a no-op. When enabled, the timer
	// schedules dream runs based on config.dreamer.schedule and uses
	// PiSubagentRunner to spawn child sessions for each task.
	const dreamerConfig = bootProjectDeps.dreamerConfig;
	if (dreamerConfig) {
		registerPiDreamerProject({
			db,
			projectDir,
			projectIdentity,
			config: dreamerConfig,
			// Council finding #7: thread real embedding + memory config so
			// dreamer can do semantic dedup AND can write memory updates.
			// Previously hardcoded to off/false, making most dreamer tasks
			// useless on Pi.
			embeddingConfig: bootProjectDeps.config.embedding,
			memoryEnabled: bootProjectDeps.config.memory.enabled,
			language: bootProjectDeps.config.language,
			gitCommitIndexing: bootProjectDeps.config.memory.git_commit_indexing,
			onAdjunctsRefreshNeeded: signalPiSystemPromptRefreshForProject,
		});
		info(`registered dreamer (${summarizeDreamSchedule(dreamerConfig)})`);
	} else {
		info(
			bootProjectDeps.dreamerEnabled
				? "registered dreamer: DISABLED (no dreamer config)"
				: "registered dreamer: DISABLED (dreamer.disable=true or no dreamer config)",
		);
	}

	// Inject the magic-context guidance block into the system prompt for every agent
	// turn, then run hash-detection + sticky-date freezing so the
	// resulting prompt stays cache-stable across turns when nothing
	// material has changed.
	//
	// Pi has prefix caching the same way legacy host does — every major
	// LLM provider (Anthropic, OpenAI, Codex, GitHub Copilot, etc.)
	// caches the system prompt portion of the prefix. Drift between
	// turns busts the cache and the user pays full input price for the
	// next call. The protections here mirror legacy host's
	// `experimental.chat.system.transform` handler in
	// `system-prompt-hash.ts`.
	pi.on("before_agent_start", async (event, ctx) => {
		// Pi MCTX stores announcements under its own Pi-managed directory.
		// Dismissing a Pi announcement never mutates legacy host state.
		// Skipped silently when:
		//   - announcement constants are empty (bugfix-only release)
		//   - the current ANNOUNCEMENT_VERSION was already dismissed in
		//     a prior Pi MCTX session
		//   - ctx.hasUI is false (print/rpc subagent — no point notifying)
		//
		// Fire-and-forget: storage write happens inside markAnnouncementSeen,
		// any failure is swallowed. Worst case is a duplicate notification
		// the next time the user starts an interactive Pi session.
		try {
			if (ctx.hasUI && shouldShowAnnouncement()) {
				// URLs render as plain text. Modern terminals auto-detect and
				// let users Cmd-click; older terminals require manual copy.
				// We previously wrapped URLs in OSC 8 hyperlink escapes, but
				// not all terminals support them and `ctx.ui.notify` may also
				// re-render the message through pi-tui's text pipeline that
				// strips raw escapes. Plain text is the most reliable surface.
				const featureText = ANNOUNCEMENT_FEATURES.map((line) => `  • ${line}`).join("\n");
				const sections = [
					`✨ Magic Context v${ANNOUNCEMENT_VERSION} — what's new:`,
					"",
					featureText,
				];
				if (ANNOUNCEMENT_FOOTER && ANNOUNCEMENT_FOOTER.trim().length > 0) {
					// Blank-line separator distinguishes the persistent footer
					// (Discord invite, etc.) from the version-specific bullets.
					sections.push("", ANNOUNCEMENT_FOOTER);
				}
				ctx.ui.notify(sections.join("\n"), "info");
				markAnnouncementSeen(ANNOUNCEMENT_VERSION);
			}
		} catch {
			// Never block agent start on announcement delivery.
		}

		try {
			const effectiveProjectDeps = resolveCurrentProjectDeps(ctx);
			const currentProject = {
				projectDir: effectiveProjectDeps.projectDir,
				projectIdentity: effectiveProjectDeps.projectIdentity,
			};
			const effectiveConfig = effectiveProjectDeps.config;
			seenDreamerProjectIdentities.add(currentProject.projectIdentity);

			// Re-register the dreamer for the CURRENT project. The boot-time
			// registration above used process.cwd(), but Pi can switch projects
			// mid-process (`/cd`, multi-root). Without this, a switched-into
			// project is never dreamed and `/ctx-dream` there throws
			// "not registered". registerPiDreamerProject is idempotent for the
			// same identity+dir, and rebuilds against the new checkout when the
			// directory changed (worktree/clone of the same repo).
			//
			// All project-sensitive config comes from resolveCurrentProjectDeps(ctx),
			// the same per-cwd accessor used by tools, commands, and the context
			// pipeline. A switched-into project may carry its own config (different
			// model/schedule, or its own `dreamer.disable`), so boot config must not
			// leak into this registration.
			const effectiveDreamerConfig = effectiveProjectDeps.dreamerConfig;
			if (effectiveDreamerConfig) {
				try {
					registerPiDreamerProject({
						db,
						projectDir: currentProject.projectDir,
						projectIdentity: currentProject.projectIdentity,
						config: effectiveDreamerConfig,
						embeddingConfig: effectiveConfig.embedding,
						memoryEnabled: effectiveConfig.memory.enabled,
						language: effectiveConfig.language,
						gitCommitIndexing: effectiveConfig.memory.git_commit_indexing,
						onAdjunctsRefreshNeeded: signalPiSystemPromptRefreshForProject,
					});
				} catch (err) {
					warn("before_agent_start: registerPiDreamerProject threw:", err);
				}
			} else {
				// The current checkout disables the dreamer. Any existing registration
				// for this identity may have been created while another checkout's
				// config was active, so tear it down explicitly here.
				try {
					unregisterPiDreamerProject({
						projectIdentity: currentProject.projectIdentity,
					});
				} catch (err) {
					warn("before_agent_start: unregisterPiDreamerProject threw:", err);
				}
			}
			// Pi exposes `sessionManager.getSessionId()` once a session is
			// active. We resolve it here defensively because before_agent_start
			// fires once per agent turn.
			const sm = ctx.sessionManager;
			let sessionId: string | undefined;
			if (sm !== undefined) {
				const getId = (sm as { getSessionId?: () => string | undefined }).getSessionId;
				if (typeof getId === "function") {
					try {
						const id = getId.call(sm);
						if (typeof id === "string" && id.length > 0) sessionId = id;
					} catch {
						// Fail open — sessionId stays undefined.
					}
				}
			}
			if (sessionId) {
				trackSessionForProject(currentProject.projectIdentity, sessionId);

				// Re-arm a pending Pi compaction-marker drain on session ACTIVATION,
				// not just at process startup. session_before_switch clears the
				// in-memory deferred-refresh/materialization sets for the outgoing
				// session (those Sets are per-process and would otherwise leak); but
				// the durable pending marker in session_meta survives. On switch-BACK
				// the marker would then sit undrained (the drain is signal-driven, and
				// startup-only rehydration never re-fires). Re-signal here when this
				// session has a durable pending marker so the next eligible materializing
				// pass drains it, using the same deferred signal shape as startup.
				//
				// Gate on the same APIs the drain itself requires
				// (sessionManager.appendCompaction + getBranch): when they're
				// unavailable the drain skips-and-PRESERVES the signal, so re-signaling
				// every turn would keep an undrainable signal armed. Only re-arm when the
				// marker can actually be applied.
				try {
					const smForDrain = sm as {
						appendCompaction?: unknown | undefined;
						getBranch?: unknown | undefined;
					};
					const canDrain =
						typeof smForDrain.appendCompaction === "function" &&
						typeof smForDrain.getBranch === "function";
					if (!compactionOff && canDrain && getPendingPiCompactionMarkerState(db, sessionId)) {
						signalPiDeferredCompactionMarkerDrain(sessionId);
					}
				} catch {
					// Best-effort: a read failure must not block agent start.
				}

				// E6d: one-time upgrade reminder for sessions with legacy (pre-v2)
				// compartments. Model-invisible (ctx.ui.notify), self-gating via the
				// durable + per-process guards in the shared helper. Only when the
				// historian can run (so /ctx-session-upgrade is actionable).
				if (!compactionOff && ctx.hasUI && effectiveProjectDeps.historianConfig?.model) {
					void maybeSendUpgradeReminder(
						{
							client: null,
							db,
							sendIgnoredMessage: async (_client, _sid, text) => {
								ctx.ui.notify(text, "info");
								return "sent";
							},
							getNotificationParams: () => ({}),
							// Pi's ctx.ui.notify is a TRANSIENT toast (no scrollback),
							// so the durable stamp must not suppress after one missed
							// toast — re-prompt each Pi start until the session upgrades.
							deliveryPersists: false,
						},
						sessionId,
					).catch(() => {
						// Never block agent start on reminder delivery.
					});
				}
			}

			if (effectiveConfig.system_prompt_injection?.enabled === false) {
				return;
			}
			const existingSystemPrompt = asPromptText(event.systemPrompt);
			const skipSigs = effectiveConfig.system_prompt_injection?.skip_signatures ?? [];
			if (skipSigs.some((sig) => sig.length > 0 && existingSystemPrompt.includes(sig))) {
				return;
			}

			const isCacheBusting = sessionId ? hasSystemPromptRefresh(sessionId) : true;

			const block = buildMagicContextBlock({
				db,
				cwd: currentProject.projectDir,
				sessionId,
				memoryEnabled: effectiveConfig.memory.enabled,
				searchEnabled: toolSettings.searchEnabled,
				noteEnabled: toolSettings.noteEnabled,
				includeGuidance: true,
				protectedTags: effectiveConfig.protected_tags,
				ctxReduceCallable: !compactionOff,
				dreamerEnabled: effectiveProjectDeps.dreamerEnabled,
				temporalAwarenessEnabled: effectiveConfig.temporal_awareness ?? false,
				cavemanTextCompressionEnabled: effectiveConfig.caveman_text_compression?.enabled === true,
				language: effectiveConfig.language,
				userMemoriesEnabled: userMemoryCollectionEnabled(effectiveConfig.dreamer),
				isCacheBusting,
				existingSystemPrompt,
			});

			const composedPrompt = appendHandoffAuthorityGuard(
				block ? `${existingSystemPrompt}\n\n${block}` : existingSystemPrompt,
				ctx,
			);

			if (!sessionId) {
				if (composedPrompt !== existingSystemPrompt) {
					return { systemPrompt: asPromptParts(composedPrompt) };
				}
				return;
			}

			const result = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: composedPrompt,
				isCacheBusting,
			});

			if (result.hashChanged) {
				signalPiHistoryRefresh(sessionId);
				signalPiSystemPromptRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
			}

			if (isCacheBusting) {
				clearSystemPromptRefresh(sessionId);
			}

			return { systemPrompt: asPromptParts(result.systemPrompt) };
		} catch (error) {
			warn("failed to build magic-context block:", error);
			return;
		}
	});
	info("registered before_agent_start system prompt injector");

	// agent_end MUST be fire-and-forget for in-flight historian / dreamer
	// runs.
	//
	// REGRESSION FIXED HERE: Earlier code awaited `awaitInFlightHistorians()`
	// inside this handler with the (incorrect) assumption that Pi's event
	// fanout is synchronous and ignores returned Promises. In reality
	// pi-coding-agent's `extensions/runner.js` does `await handler(event, ctx)`
	// for every extension `agent_end` handler, and `agent-session.js`
	// awaits its own emit before delivering the UI-facing `agent_end`.
	// The TUI loader stops only after that UI event. Net effect: every
	// turn that triggered a historian (a 30s+ background subagent) left
	// the user staring at "Working..." with `historian` pinned in the
	// footer until the background run finished — the OPPOSITE of the
	// "compact in the background while the main agent keeps working"
	// invariant magic-context is supposed to provide.
	//
	// Why fire-and-forget is safe in interactive mode:
	//   - The Pi process stays alive between turns. The next turn's
	//     `pi.on("context")` handler checks `inFlightHistorian.has(sessionId)`
	//     and skips re-firing while a previous historian is still
	//     running, so we never double-spawn.
	//   - Historian publication paths register the run promise in
	//     `inFlightHistorian` so emergency 95% waits and `session_shutdown`
	//     drainage can still join the background work when actually
	//     needed.
	//   - All work historian does is durable (compartment + fact rows,
	//     publish marker, signalPiHistoryRefresh). Even if the user
	//     closes Pi mid-historian and the subprocess gets killed, the
	//     next session start re-evaluates and either picks up where the
	//     prior run left off or recovers from `historian_failure_count`.
	//
	// `pi --print` (single-turn, exits after agent_end) is the one mode
	// where backgrounding is genuinely incompatible with subprocess
	// lifetime — Pi's process exits and SIGKILLs the still-running
	// historian. That tradeoff is intentional: print mode is for
	// scripting / one-shot tasks where blocking the user's interactive
	// shell on a 30s historian is also wrong, just in a different way.
	// We let print mode skip the wait too. Users who want guaranteed
	// historian completion in print mode should run interactive Pi
	// instead.
	pi.on("agent_end", (event, ctx) => {
		// Synchronous return — DO NOT await background work here.
		// awaitInFlightHistorians()/awaitInFlightDreamers() are still
		// invoked at session_shutdown where they belong (and where pi
		// gives us a window before tearing down stdio). Errors from
		// background runs are handled by their own try/catch chains
		// (runPiHistorian wraps everything; spawnPiHistorianRun's
		// .finally cleans up the inFlight map).
		log("agent_end: returning synchronously (background work continues)");

		// Channel 2 (ceiling) nudge delivery — the Pi analog of legacy host's
		// event-handler delivery on terminal message.updated. The pipeline
		// records a `pending` intent near the threshold; deliver it here at the
		// turn boundary via sendUserMessage(followUp). Internally CAS-gated to
		// one delivery per session lifetime, and no-ops unless `pending`.
		// Fire-and-forget; never block agent_end.
		//
		// Deliver ONLY on a clean final stop. Pi emits agent_end for error /
		// aborted responses and for retry attempts too (agent-loop); delivering
		// on those would inject the follow-up mid-retry and burn the one-shot cap
		// before the turn actually completed. legacy host's equivalent gates on
		// finish === "stop". Mirror that with the final assistant's stopReason.
		try {
			const msgs = (event as { messages?: Array<{ role?: string; stopReason?: string }> })
				?.messages;
			const lastAssistant = Array.isArray(msgs)
				? [...msgs].reverse().find((m) => m?.role === "assistant")
				: undefined;
			if (lastAssistant?.stopReason === "stop") {
				const sessionId = ctx.sessionManager?.getSessionId?.();
				if (sessionId && db && !compactionOff) maybeDeliverChannel2Pi(pi, db, sessionId);
			}
		} catch (err) {
			log(`agent_end: channel2 delivery skipped: ${String(err)}`);
		}
	});

	// Tool-execution-start only clears note-nudge state after ctx_note.
	pi.on("tool_execution_start", async (event, ctx) => {
		try {
			if (event.toolName !== "ctx_note") return;
			const sessionId = ctx.sessionManager.getSessionId();
			clearNoteNudgeTriggerAndCooldown(db, sessionId);
		} catch (err) {
			log(
				`tool_execution_start hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			if (!compactionOff && event.toolName === "ctx_reduce") {
				markPiChannel1Reduced(sessionId, db);
			}
		} catch (err) {
			log(
				`tool_execution_end hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	// Channel 1 is a separate persisted custom message. Its raw content remains
	// model-visible `<system-reminder>` text; the renderer shows a [magic context]
	pi.on("tool_result", (event, ctx) => {
		const annotatedContent = annotateEmptyTaskOutputContent(event.toolName, event.content);
		const resultContent = annotatedContent ?? event.content;
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (typeof sessionId === "string" && sessionId.length > 0 && !compactionOff) {
				maybeDeliverChannel2Pi(pi, db, sessionId, "steer");
				const reminder = maybeChannel1ReminderForToolResult({
					db,
					sessionId,
					toolName: event.toolName,
					content: resultContent,
				});
				if (reminder) {
					pi.sendMessage(
						{
							customType: CHANNEL1_NUDGE_CUSTOM_TYPE,
							content: reminder.content,
							display: reminder.display,
							details: { displayText: reminder.displayText },
						},
						{ deliverAs: "steer" },
					);
					markChannel1ReminderDelivered(db, sessionId, reminder);
				}
			}
		} catch (err) {
			log(
				`tool_result hook failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (annotatedContent) return { content: annotatedContent as typeof event.content };
	});

	// In normal mode MC owns compaction and cancels Pi's native hook. In
	// compaction-off mode the same hook must return nothing: native Pi compaction
	// is the selected context manager and cancelling it would leave no manager.
	pi.on("session_before_compact", async (_event, ctx) =>
		handlePiSessionBeforeCompact({ db, compactionOff, ctx }),
	);

	// OMP MessageEndEvent.message is a detached snapshot; mutating it
	// does not persist. Tag prefix strip lives in the `context` transform.
	pi.on("message_end", async (event, ctx) => {

		// Update last_response_time + last_input_tokens + last_context_percentage
		// so the scheduler's TTL gating can decide between execute and defer
		// on the next transform pass. Without this, every Pi pass would either
		// always execute (stale lastResponseTime=0 → TTL elapsed) or always
		// defer (no usage data) — neither matches legacy host parity.
		try {
			const sm = ctx.sessionManager as { getSessionId?: () => string | undefined } | undefined;
			const sessionId = sm?.getSessionId?.();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			const endedMsg = event.message as unknown as {
				id?: string | undefined;
				role?: string | undefined;
			};
			if (
				endedMsg?.role === "assistant" &&
				typeof endedMsg.id === "string" &&
				endedMsg.id.length > 0
			) {
				advancePiChannel1Turn(sessionId);
				const messageId = endedMsg.id;
				scheduleIncrementalIndex(db, sessionId, messageId, () => {
					const rawMessages = readPiSessionMessages(ctx);
					return rawMessages.find((message) => message.id === messageId) ?? null;
				});
			}
			persistPiMessageEndModelMeta({
				db,
				sessionId,
				message: event.message,
				cacheTtlConfig: resolveCurrentProjectDeps(ctx).config.cache_ttl,
			});
			// Compute pressure with legacy host-equivalent semantics: pull
			// the assistant's `usage` field and use
			// `input + cacheRead + cacheWrite` (NOT output) divided by
			// the effective context limit. The window comes from Pi's own
			// runtime — `getContextUsage().contextWindow`, falling back to
			// `ctx.model.contextWindow` if usage hasn't populated — NOT
			// models.dev. `session_meta.detected_context_limit` still overrides
			// it (in persistPiPressureFromMessageEnd) so post-overflow pressure
			// reflects the real, lower limit. See `pi-pressure.ts` for rationale.
			const piUsage = ctx.getContextUsage?.();
			const piContextWindow =
				piUsage && typeof piUsage.contextWindow === "number" && piUsage.contextWindow > 0
					? piUsage.contextWindow
					: (ctx.model?.contextWindow ?? 0);
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: event.message,
				piContextWindow,
				piModel: ctx.model
					? {
							provider: ctx.model.provider,
							id: ctx.model.id,
							maxTokens: undefNum(ctx.model.maxTokens),
						}
					: undefined,
				piTokens: piUsage && typeof piUsage.tokens === "number" ? piUsage.tokens : undefined,
				notifyIssue: async (message) => {
					const uiNotify = (ctx as { ui?: { notify?: (message: string) => unknown } }).ui?.notify;
					if (typeof uiNotify === "function") {
						void uiNotify.call(ctx.ui, message);
					} else {
						warn(message);
					}
				},
			});
		} catch (err) {
			warn("message_end: persist session_meta usage failed:", err);
		}

		// Overflow recovery: if Pi's assistant message ended with a
		// provider context-overflow error (`message.errorMessage` matches
		// a known overflow pattern), record the recovery flag in
		// session_meta so the next transform pass treats this session as
		// "needs emergency recovery" — historian fires immediately, drop-
		// all-tools applies, and pressure math uses the real
		// detected_context_limit if the error reported one.
		//
		// Pi populates `errorMessage` on the assistant message when the
		// underlying API call fails (we saw exactly this pattern in the
		// Codex `context_length_exceeded` failure that motivated this
		// work). The provider-agnostic `detectOverflow` helper from
		// shared core matches Anthropic, OpenAI, Codex/OpenAI, xAI,
		// Cerebras, GitHub Copilot, OpenRouter, Ollama, vLLM, Mistral,
		// MiniMax, Kimi, Gemini, and a generic fallback.
		try {
			if (compactionOff) return;
			const sm = ctx.sessionManager as { getSessionId?: () => string | undefined } | undefined;
			const sessionId = sm?.getSessionId?.();
			if (typeof sessionId !== "string" || sessionId.length === 0) return;
			const msgRaw = event.message as unknown;
			if (!msgRaw || typeof msgRaw !== "object") return;
			const msg = msgRaw as {
				role?: string | undefined;
				errorMessage?: string | undefined;
				provider?: string | undefined;
				model?: string | undefined;
			};
			if (msg.role !== "assistant") return;
			if (typeof msg.errorMessage !== "string" || msg.errorMessage.length === 0) {
				return;
			}
			const detection = detectOverflow(msg.errorMessage);
			if (!detection.isOverflow) return;
			const modelKey =
				typeof msg.provider === "string" &&
				typeof msg.model === "string" &&
				msg.provider.length > 0 &&
				msg.model.length > 0
					? `${msg.provider}/${msg.model}`
					: undefined;
			recordOverflowDetected(
				db,
				sessionId,
				detection.reportedLimit,
				modelKey,
				"provider_overflow",
				detection.reportedLimitProvenance,
			);
			log(
				`[magic-context][${sessionId}] overflow detected: reportedLimit=${
					detection.reportedLimit ?? "?"
				} provenance=${detection.reportedLimitProvenance ?? "?"} pattern=${detection.matchedPattern ?? "?"}`,
			);
		} catch (err) {
			warn("message_end: overflow detection failed:", err);
		}
	});

	// Unregister project from dreamer timer on session shutdown. Pi's
	// `/reload` command tears down extensions and re-runs this default
	// export — without unregistering, the dreamer timer would hold a
	// stale reference to the previous extension instance.
	//
	// IMPORTANT: We do NOT close the SQLite handle here. `openDatabase()`
	// caches handles in a process-lifetime Map keyed by path; closing
	// the handle invalidates the cache entry, but the Map still returns
	// the closed handle on the next `openDatabase()` call after reload,
	// causing every tool/hook to fail with "database is not open". The
	// DB handle is intentionally process-lifetime — Pi's `/reload`
	// re-runs the extension code but keeps the host process alive, so
	// the cached handle is still valid across reload boundaries.
	pi.on("session_shutdown", async (_event, ctx) => {
		// Bounded drain of in-flight historian / dreamer runs that were
		// kicked off by recent turns. We moved the drain here from
		// `agent_end` because Pi awaits agent_end handlers and was
		// stalling the UI loader on every turn that triggered historian.
		// session_shutdown only fires when the user is actually leaving
		// the session, so a brief wait is acceptable — and lets the
		// JSONL session state reach a consistent compartment boundary
		// before the process exits.
		//
		// 5-second cap protects interactive shutdown from a hung
		// subagent. In `pi --print` mode the process exits after
		// agent_end before this handler fires anyway, so the cap
		// doesn't help that mode (and we don't pretend it does — see
		// the comment block on the agent_end handler above).
		const SHUTDOWN_DRAIN_MS = 5_000;
		try {
			await withTimeout(awaitInFlightHistorians(), SHUTDOWN_DRAIN_MS);
		} catch (err) {
			warn("shutdown: historian drain threw:", err);
		}
		try {
			await withTimeout(awaitInFlightRecomps(), SHUTDOWN_DRAIN_MS);
		} catch (err) {
			warn("shutdown: recomp drain threw:", err);
		}
		try {
			await withTimeout(awaitInFlightDreamers(), SHUTDOWN_DRAIN_MS);
		} catch (err) {
			warn("shutdown: dreamer drain threw:", err);
		}
		try {
			for (const identity of seenDreamerProjectIdentities) {
				unregisterPiDreamerProject({ projectIdentity: identity });
			}
		} catch (err) {
			warn("shutdown: unregisterPiDreamerProject threw:", err);
		}
		// Clear per-session system-prompt adjunct caches (sticky date,
		// project docs, user profile, key files). Pi's
		// `_extensionRunner.invalidate` resets module state on session
		// swap, but on plain shutdown the maps would otherwise hold
		// their last entries. Best-effort: if sessionId can't be
		// resolved we just skip — Pi resets module state on /reload
		// anyway.
		try {
			const sm = (
				ctx as unknown as {
					sessionManager?: { getSessionId?: () => string | undefined };
				}
			).sessionManager;
			const sessionId = typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
			if (typeof sessionId === "string" && sessionId.length > 0) {
				clearPiSystemPromptSession(sessionId);
				// Drain context-handler session-keyed maps too. Without
				// this, sessions accumulate state across `session_shutdown`
				// in long-lived Pi processes that re-init the extension.
				clearContextHandlerSession(sessionId);
			}
		} catch {
			// best-effort cleanup
		}
		// Re-arm the process-global init latch (issue #247). Pi fires
		// `session_shutdown` (reason "reload") before a `/reload` re-imports
		// extensions, and (reason "shutdown") when the user leaves the
		// session. Each AgentSession owns its own ExtensionRunner, so an
		// in-process child's `session_shutdown` only fires handlers the
		// CHILD registered — and a child that no-op'd via the latch
		// registered none, so it cannot clear the parent's latch. Clearing
		// here lets a `/reload` legitimately re-initialize the full runtime,
		// while ephemeral in-process children never touch it.
		clearPiMagicContextActive();
	});

	// Pi has no `session_deleted` event, but `session_before_switch`
	// fires when the user switches to a different session within the
	// same Pi process. That's the right moment to drain caches keyed
	// by the OUTGOING session id — without this, every session swap
	// in a long-running Pi process leaks one entry per cache, and
	// after dozens of swaps the maps balloon. Cleanup here mirrors
	// legacy host's `session.deleted` handler in `event-handler.ts`.
	pi.on("session_before_switch", (_event, ctx) => {
		try {
			const sm = (
				ctx as unknown as {
					sessionManager?: { getSessionId?: () => string | undefined };
				}
			).sessionManager;
			const outgoingSessionId =
				typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined;
			if (typeof outgoingSessionId === "string" && outgoingSessionId.length > 0) {
				// Clear ONLY the in-memory per-session maps (the actual leak that
				// grows one entry per swap). Do NOT clear the durable DB m[0] cache
				// here: session_before_switch is REVERSIBLE (the user can switch
				// back), unlike legacy host's session.deleted. The DB cache is bounded
				// (one session_meta row per session) and self-invalidates via
				// epoch/version/docs-hash checks in mustMaterializePi, so preserving
				// it lets a switch-back reuse the cached prefix instead of forcing a
				// full m[0] re-materialization (an avoidable prompt-cache bust).
				clearPiSystemPromptSession(outgoingSessionId);
				clearContextHandlerSession(outgoingSessionId);
			}
		} catch {
			// best-effort — Pi proceeds with the switch regardless
		}
	});
}

/**
 * Format `execute_threshold_percentage` for the boot log. The config accepts
 * either a bare number or a per-model map (`{ default: 65, "provider/model": 50 }`);
 * naive interpolation printed the map form as `[object Object]%`.
 */
function formatExecuteThresholdForLog(
	value: number | { default: number; [modelKey: string]: number } | undefined,
): string {
	if (value === undefined) return "65%";
	if (typeof value === "number") return `${value}%`;
	const overrides = Object.entries(value)
		.filter(([key]) => key !== "default")
		.map(([key, pct]) => `${key}=${pct}%`);
	const base = `${value.default}%`;
	return overrides.length > 0 ? `${base} (${overrides.join(", ")})` : base;
}
