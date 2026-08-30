import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { withContentLanguageDirective } from "#core/agents/language-directive";
import { getCompartments } from "#core/features/compartment-storage";
import { isMemoryMigrationDone } from "#core/features/memory/memory-migration";
import { resolveProjectIdentityForSession } from "#core/features/memory/project-identity";
import type { ContextDatabase } from "#core/features/storage";
import { isWrapupInProgress } from "#core/features/storage-meta-persisted";
import { COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT } from "#core/hooks/compartment-prompt";
import { executeContextRecompWithResult } from "#core/hooks/compartment-runner";
import type { RawMessageProvider } from "#core/hooks/read-session-chunk";
import {
	contextualizeUpgradeReason,
	extractRecompReason,
	isRecompComplete,
	isRecompFailure,
} from "#core/hooks/recomp-orchestrator";
import { describeError } from "#core/shared/error-message";
import { sessionLog } from "#core/shared/logger";
import type { SubagentRunner } from "#core/shared/subagent-runner";
import { COMPACTION_OFF_COMMAND_UNAVAILABLE } from "../compaction-off-pi";
import {
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
} from "../context-handler";
import { ensureProjectRegisteredFromPiDirectory } from "../embedding-bootstrap";
import { runPiMemoryMigration } from "../pi-memory-migration";
import { createPiHistorianClient } from "../pi-recomp-client-shared";
import { stagePiRecompMarker } from "../pi-recomp-marker";
import { isPiRecompInFlight, spawnPiRecompRun } from "../pi-recomp-runner";
import { readPiSessionMessages } from "../read-session-pi";
import { updateStatusLine } from "../status-line";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export interface CtxSessionUpgradeRuntimeDeps {
	db: ContextDatabase;
	runner: SubagentRunner;
	historianModel: string | undefined;
	historianChunkTokens: number;
	historianFallbacks?: readonly string[] | undefined;
	historianTimeoutMs?: number | undefined;
	historianThinkingLevel?: string | undefined;
	language?: string | undefined;
	memoryEnabled: boolean;
	/** Allow a session started exactly in the canonical home directory only when user-level configuration enables it. */
	allowHomeProject?: boolean | undefined;
	autoPromote: boolean;
	userMemoriesEnabled?: boolean | undefined;
	compactionOff?: boolean | undefined;
}

export interface RegisterCtxSessionUpgradeDeps extends CtxSessionUpgradeRuntimeDeps {
	resolveRuntimeDeps?: ((ctx: { cwd: string }) => CtxSessionUpgradeRuntimeDeps) | undefined;
}

/**
 * /ctx-session-upgrade (E6b/E6c parity with legacy host E3.1/E3.2).
 *
 * Upgrades THIS Pi session to the v2 history format:
 *   1. Full recomp — rebuilds every legacy v1 compartment into the v2 tiered
 *      shape (recomp emits NO facts, so curated memories are untouched here).
 *   2. Memory migration — re-evaluates the project's memories into the v2
 *      5-category taxonomy (once per project, idempotent).
 *
 * Session-scoped recomp + project-scoped (once-per-project) migration. Uses the
 * historian model/runner, so it works even when the dreamer is disabled.
 */
export function registerCtxSessionUpgradeCommand(
	pi: ExtensionAPI,
	deps: RegisterCtxSessionUpgradeDeps,
): void {
	pi.registerCommand("ctx-session-upgrade", {
		description:
			"Upgrade this session to the current Magic Context history format and re-organize project memories",
		handler: async (_args, ctx) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}
			const currentDeps = deps.resolveRuntimeDeps?.(ctx) ?? deps;
			if (currentDeps.compactionOff) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: COMPACTION_OFF_COMMAND_UNAVAILABLE,
					level: "warning",
				});
				return;
			}
			if (!currentDeps.historianModel) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nUnavailable because `historian.model` is not configured.",
					level: "error",
				});
				return;
			}

			if (isWrapupInProgress(currentDeps.db, sessionId)) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\n/ctx-wrapup is already compacting this session. Wait for it to finish, then try again.",
					level: "warning",
				});
				return;
			}

			if (isPiRecompInFlight(sessionId)) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nAn upgrade or recomp is already running for this session in the background. Wait for it to finish, then try again.",
					level: "warning",
				});
				return;
			}

			// "Upgradable" = lacks usable v2 tiers: a pre-v2 `legacy=1` row OR a
			// malformed `legacy=0` row with no `p1` (interrupted recomp / older
			// partial-v2 build). Matching ONLY `legacy=1` would trap a session
			// whose rows are tierless-but-not-flagged-legacy (parity with
			// legacy host runManagedUpgrade; dogfood 2026-05-30 AFT).
			const compartments = getCompartments(currentDeps.db, sessionId);
			const upgradableCount = compartments.filter(
				(c) => c.legacy === 1 || !c.p1 || c.p1.trim() === "",
			).length;

			// The session main model leads the migration chain (parity with
			// legacy host's primaryModelId): a quality-sensitive consolidation should
			// run on the user's working model, not the (possibly misconfigured)
			// historian model. Historian model + fallbacks remain the safety net.
			const sessionMainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

			// Migration runs only when memory is enabled — parity with legacy host,
			// whose orchestrator gates on `runMigration = memory.enabled !== false
			// && historian.model` (recomp-orchestrator drives migration off that
			// flag, NOT unconditionally). With memory disabled there is no memory
			// pool to re-organize, so re-categorizing would be a no-op at best and
			// could touch a pool the user opted out of at worst.
			const migrationEnabled = currentDeps.memoryEnabled;

			const runMigration = async (): Promise<string> => {
				if (!migrationEnabled) {
					return "Memory migration skipped (memory disabled).";
				}
				// runPiMemoryMigration further self-gates via its own
				// once-per-project / empty-pool / USER_* guards.
				try {
					const outcome = await runPiMemoryMigration({
						db: currentDeps.db,
						runner: currentDeps.runner,
						...(sessionMainModel === undefined ? {} : { primaryModel: sessionMainModel }),
						model: currentDeps.historianModel as string,
						...(currentDeps.historianFallbacks === undefined
							? {}
							: { fallbackModels: currentDeps.historianFallbacks }),
						...(currentDeps.historianTimeoutMs === undefined
							? {}
							: { timeoutMs: currentDeps.historianTimeoutMs }),
						...(currentDeps.historianThinkingLevel === undefined
							? {}
							: { thinkingLevel: currentDeps.historianThinkingLevel }),
						directory: ctx.cwd,
						...(currentDeps.allowHomeProject === undefined
							? {}
							: { allowHomeProject: currentDeps.allowHomeProject }),
						sessionId,
						...(currentDeps.userMemoriesEnabled === undefined
							? {}
							: { userMemoriesEnabled: currentDeps.userMemoriesEnabled }),
						...(currentDeps.language === undefined ? {} : { language: currentDeps.language }),
					});
					return outcome.summary;
				} catch (error) {
					return `Memory migration skipped (error): ${describeError(error).brief}`;
				}
			};

			// ── Guard: already-upgraded session (parity with legacy host) ──────────
			// No upgradable compartments → don't run a wasteful/risky full recomp.
			//   • none + migration already done → no-op "already upgraded"
			//   • none + migration still pending → migration only (skip recomp)
			if (upgradableCount === 0) {
				const projectPath = resolveProjectIdentityForSession(ctx.cwd, currentDeps.allowHomeProject);
				if (!projectPath) return;
				// migrationPending mirrors legacy host: only pending when memory is
				// enabled AND the project hasn't been migrated yet.
				const migrationPending =
					migrationEnabled && !isMemoryMigrationDone(currentDeps.db, projectPath);
				if (!migrationPending) {
					sendCtxStatusMessage(pi, {
						title: "/ctx-session-upgrade",
						text: [
							"## Session Upgrade — Already Up To Date",
							"",
							compartments.length === 0
								? "This session has no compartment history to upgrade yet."
								: "This session's compartments are already in the current format.",
						].join("\n"),
						level: "info",
					});
					return;
				}
				// Compartments current but project memories never migrated — run
				// migration only. Detached so the single migration LLM call doesn't
				// block the Pi REPL either (parity with the full-recomp path below).
				sendCtxStatusMessage(pi, {
					title: "/ctx-session-upgrade",
					text: "## Session Upgrade\n\nCompartments are already current. Re-organizing project memories. This may take a while.",
					level: "info",
				});
				spawnPiRecompRun({
					sessionId,
					provider: {
						readMessages: () => readPiSessionMessages(ctx),
					} satisfies RawMessageProvider,
					onStatusChange: () =>
						updateStatusLine(ctx, {
							db: currentDeps.db,
							projectIdentity: ctx.cwd,
						}),
					work: async () => {
						const summary = await runMigration();
						sendCtxStatusMessage(pi, {
							title: "/ctx-session-upgrade",
							text: ["## Session Upgrade — Complete", "", summary].join("\n"),
							level: "info",
						});
					},
				});
				return;
			}

			sendCtxStatusMessage(pi, {
				title: "/ctx-session-upgrade",
				text: "## Session Upgrade\n\nRebuilding compartments into the v2 format and re-organizing project memories. This may take a while.",
				level: "info",
			});

			const provider = {
				readMessages: () => readPiSessionMessages(ctx),
			} satisfies RawMessageProvider;

			// Detached: the upgrade (multi-pass recomp + memory migration) runs in
			// the background so the Pi REPL stays responsive (parity with legacy host's
			// `void runManagedUpgrade`). The command handler returns right after the
			// "Rebuilding…" ack above. Provider registration, the `recomp`
			// status-line flag, shutdown-drain tracking, and cleanup are owned by
			// spawnPiRecompRun.
			spawnPiRecompRun({
				sessionId,
				provider,
				onStatusChange: () =>
					updateStatusLine(ctx, {
						db: currentDeps.db,
						projectIdentity: ctx.cwd,
					}),
				work: async () => {
					// Step 1 — compartment upgrade via full recomp.
					const recompResult = await executeContextRecompWithResult(
						{
							client: createPiHistorianClient({
								runner: currentDeps.runner,
								model: currentDeps.historianModel as string,
								...(currentDeps.historianFallbacks === undefined
									? {}
									: { fallbackModels: currentDeps.historianFallbacks }),
								...(currentDeps.historianTimeoutMs === undefined
									? {}
									: { timeoutMs: currentDeps.historianTimeoutMs }),
								...(currentDeps.historianThinkingLevel === undefined
									? {}
									: { thinkingLevel: currentDeps.historianThinkingLevel }),
								directory: ctx.cwd,
								accountingSessionId: sessionId,
								systemPrompt: withContentLanguageDirective(
									COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
									currentDeps.language,
									{ preserveUserQuotes: true },
								),
								notify: (text) =>
									sendCtxStatusMessage(pi, {
										title: "/ctx-session-upgrade",
										text,
										level: "info",
									}),
							}) as never,
							db: currentDeps.db,
							sessionId,
							historianChunkTokens: currentDeps.historianChunkTokens,
							directory: ctx.cwd,
							...(currentDeps.historianTimeoutMs === undefined
								? {}
								: { historianTimeoutMs: currentDeps.historianTimeoutMs }),
							memoryEnabled: currentDeps.memoryEnabled,
							autoPromote: currentDeps.autoPromote,
							// Embedding substrate: without this the recomp publish path
							// no-ops chunk embedding on an unregistered project, leaving
							// rebuilt compartments out of ctx_search. Parity with legacy host.
							ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
							// Recomp-runner model chain (parity with legacy host
							// recomp-orchestrator): configured fallbacks + the session's
							// own model as the last-ditch retry, so an empty/invalid-but-
							// HTTP-200 historian primary escalates instead of failing.
							...(currentDeps.historianFallbacks === undefined
								? {}
								: { fallbackModels: currentDeps.historianFallbacks }),
							...(sessionMainModel === undefined ? {} : { fallbackModelId: sessionMainModel }),
							...(currentDeps.language === undefined ? {} : { language: currentDeps.language }),
						},
						{},
					);

					// Gate migration + "Complete" on `published` — the GROUND TRUTH
					// that recomp actually rebuilt compartments (parity with legacy host
					// runManagedUpgrade). A recomp can no-op WITHOUT a "— Failed/Skipped"
					// heading (lease/activeRuns guard returns "Historian already
					// running…"), which isRecompFailure misses. Running migration +
					// declaring Complete on a skipped recomp leaves tierless rows but
					// migrated memories + a project-wide cache-bust from the epoch bump
					// (dogfood 2026-05-30, AFT false-complete under concurrent processes).
					// Require a POSITIVE full-success ("— Complete"), not merely the
					// absence of a Failed/Skipped heading: a published "— Partial"
					// rebuilt only a prefix (published===true, not a failure heading),
					// and running migration + declaring Complete on it would migrate
					// memories while leaving tierless legacy rows. Mirrors legacy host's
					// recomp-orchestrator gate.
					if (!recompResult.published || !isRecompComplete(recompResult.message)) {
						const reason = contextualizeUpgradeReason(
							isRecompFailure(recompResult.message)
								? extractRecompReason(recompResult.message)
								: `Compartments were not fully rebuilt: ${extractRecompReason(recompResult.message)}`,
						);
						sendCtxStatusMessage(pi, {
							title: "/ctx-session-upgrade",
							text: `## Session Upgrade — Incomplete\n\n${reason}`,
							level: "error",
						});
						return;
					}

					// DEFERRED staging (background-safe): stage the native marker as a
					// pending blob + signal a DEFERRED history refresh so the next
					// transform pass (at a turn boundary) drains and applies it. The
					// detached run must NOT apply the marker eagerly (appendCompaction
					// mutates getBranch immediately, which from a background task could
					// land mid-turn) nor use the eager history/materialization signals
					// — those would force a materialization on whatever pass is
					// running, possibly mid-turn, busting the cache. Mirrors the
					// background historian's onPublished (signalPiDeferred*).
					//
					// Isolated in its own try/catch: marker staging is best-effort (the
					// next incremental historian pass re-stages a covering marker), so a
					// throw here must NOT skip the refresh signals, the memory
					// migration, or the "Complete" message below — recomp already
					// published.
					try {
						stagePiRecompMarker({ db: currentDeps.db, sessionId, ctx });
					} catch (markerError) {
						sessionLog(
							sessionId,
							`pi /ctx-session-upgrade marker staging failed (non-fatal, recomp already published): ${describeError(markerError).brief}`,
						);
					}

					signalPiDeferredHistoryRefresh(sessionId);
					signalPiDeferredMaterialization(sessionId);

					// Step 2 — memory migration (once per project, idempotent).
					const migrationSummary = await runMigration();

					sendCtxStatusMessage(pi, {
						title: "/ctx-session-upgrade",
						text: [
							"## Session Upgrade — Complete",
							"",
							upgradableCount > 0
								? `Rebuilt ${upgradableCount} legacy compartment${upgradableCount === 1 ? "" : "s"} into the v2 format.`
								: "Rebuilt this session's compartments into the v2 format.",
							migrationSummary ? `\n${migrationSummary}` : "",
							"",
							recompResult.message,
						].join("\n"),
						level: "info",
					});
				},
			});
		},
	});
}
