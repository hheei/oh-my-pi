import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getCompartments } from "#core/features/compartment-storage";
import { getMostRecentTaskRunAt } from "#core/features/dreamer/storage-task-schedule";
import { getMemoryCount } from "#core/features/memory/storage-memory";
import { type ContextDatabase, getPendingOps } from "#core/features/storage";
import { getOrCreateSessionMeta } from "#core/features/storage-meta";
import { getOverflowState } from "#core/features/storage-meta-persisted";
import { getNotes } from "#core/features/storage-notes";
import { getTagsBySession } from "#core/features/storage-tags";
import { executeStatus } from "#core/hooks/execute-status";
import { describeError } from "#core/shared/error-message";
import { showStatusDialog } from "../dialogs/status-dialog";
import { resolvePiUsableContextLimit } from "../pi-context-limit";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export interface RegisterCtxStatusDeps {
	db: ContextDatabase;
	projectIdentity: string;
	resolveStatusDeps?: ((ctx: { cwd: string }) => CtxStatusRuntimeDeps) | undefined;
	resolveProject?:
		| ((ctx: { cwd: string }) => {
				projectDir: string;
				projectIdentity: string;
		  })
		| undefined;
	protectedTags?: number | undefined;
	executeThresholdPercentage?: number | { default: number; [modelKey: string]: number } | undefined;
	historyBudgetPercentage?: number | undefined;
	injectionBudgetTokens?: number | undefined;
	commitClusterTrigger?: { enabled: boolean; min_clusters: number } | undefined;
	executeThresholdTokens?:
		| {
				default?: number | undefined;
				[modelKey: string]: number | undefined;
		  }
		| undefined;
	dreamer?: { runnable?: boolean; scheduleSummary?: string } | undefined;
}

export type CtxStatusRuntimeDeps = Omit<RegisterCtxStatusDeps, "resolveStatusDeps">;

export interface CtxStatusDetails {
	sessionId: string;
	projectIdentity: string;
	activeTags: number;
	droppedTags: number;
	totalBytes: number;
	pendingOps: number;
	lastExecuteThreshold: number;
	compartmentCount: number;
	lastCompartmentRange: string | null;
	memoryCount: number;
	noteCount: number;
	dreamer: {
		enabled: boolean;
		scheduleSummary: string | null;
		lastRunAt: number | null;
	};
	historian: {
		lastFireCount: number;
		inProgress: boolean;
		lastFailureAt: number | null;
		lastError: string | null;
		failureCount: number;
	};
}

export function registerCtxStatusCommand(pi: ExtensionAPI, deps: RegisterCtxStatusDeps): void {
	pi.registerCommand("ctx-status", {
		description: "Show Magic Context status for the current Pi session",
		handler: async (_args, ctx) => {
			const runtimeDeps = deps.resolveStatusDeps?.(ctx) ?? deps;
			const projectIdentity =
				runtimeDeps.resolveProject?.(ctx).projectIdentity ?? runtimeDeps.projectIdentity;
			const currentDeps = { ...runtimeDeps, projectIdentity };
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-status",
					text: "## Magic Status\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}

			try {
				if (ctx.hasUI) {
					await showStatusDialog(pi, ctx, currentDeps);
					return;
				}

				const usage = ctx.getContextUsage?.();
				const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				let detectedContextLimit: number | undefined;
				try {
					const detected = getOverflowState(currentDeps.db, sessionId).detectedContextLimit;
					if (detected > 0) detectedContextLimit = detected;
				} catch {
					// Status remains available when overflow metadata cannot be read.
				}
				const usableContextLimit = resolvePiUsableContextLimit({
					rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
					...(ctx.model === undefined ? {} : { model: ctx.model }),
					...(detectedContextLimit === undefined ? {} : { detectedContextLimit }),
				});
				const statusText = executeStatus(
					currentDeps.db,
					sessionId,
					currentDeps.protectedTags ?? 20,
					currentDeps.executeThresholdPercentage,
					modelKey,
					currentDeps.historyBudgetPercentage,
					currentDeps.commitClusterTrigger,
					currentDeps.executeThresholdTokens,
					usableContextLimit,
				);
				const details = buildStatusDetails(currentDeps, sessionId);
				sendCtxStatusMessage(
					pi,
					{ title: "/ctx-status", text: statusText, level: "info" },
					details,
				);
			} catch (error) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-status",
					text: `## Magic Status — Failed\n\n${describeError(error).brief}`,
					level: "error",
				});
			}
		},
	});
}

function buildStatusDetails(deps: RegisterCtxStatusDeps, sessionId: string): CtxStatusDetails {
	const meta = getOrCreateSessionMeta(deps.db, sessionId);
	const tags = getTagsBySession(deps.db, sessionId);
	const activeTags = tags.filter((tag) => tag.status === "active");
	const droppedTags = tags.filter((tag) => tag.status === "dropped");
	const compartments = getCompartments(deps.db, sessionId);
	const lastCompartment = compartments[compartments.length - 1];
	const totalBytes = activeTags.reduce((sum, tag) => sum + tag.byteSize, 0);

	return {
		sessionId,
		projectIdentity: deps.projectIdentity,
		activeTags: activeTags.length,
		droppedTags: droppedTags.length,
		totalBytes,
		pendingOps: getPendingOps(deps.db, sessionId).length,
		lastExecuteThreshold: meta.timesExecuteThresholdReached,
		compartmentCount: compartments.length,
		lastCompartmentRange: lastCompartment
			? `${lastCompartment.startMessage}-${lastCompartment.endMessage}`
			: null,
		memoryCount: getMemoryCount(deps.db, deps.projectIdentity),
		noteCount:
			getNotes(deps.db, { sessionId, type: "session", status: "active" }).length +
			getNotes(deps.db, {
				projectPath: deps.projectIdentity,
				type: "smart",
				status: ["pending", "ready"],
			}).length,
		dreamer: {
			enabled: deps.dreamer?.runnable === true,
			scheduleSummary: deps.dreamer?.scheduleSummary ?? null,
			// Dreamer V2 retired the V1 dream_state['last_dream_at'] field; the
			// live "last successful run" is MAX(last_run_at) across the project's
			// task_schedule_state rows (issue #194).
			lastRunAt: getMostRecentTaskRunAt(deps.db, deps.projectIdentity),
		},
		historian: readHistorianState(deps.db, sessionId, meta),
	};
}

function readHistorianState(
	db: ContextDatabase,
	sessionId: string,
	meta: ReturnType<typeof getOrCreateSessionMeta>,
): CtxStatusDetails["historian"] {
	const row = db
		.prepare<
			[string],
			{
				historian_failure_count: number | null;
				historian_last_error: string | null;
				historian_last_failure_at: number | null;
			}
		>(
			"SELECT historian_failure_count, historian_last_error, historian_last_failure_at FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId);
	return {
		lastFireCount: meta.timesExecuteThresholdReached,
		inProgress: meta.compartmentInProgress,
		lastFailureAt:
			typeof row?.historian_last_failure_at === "number" ? row.historian_last_failure_at : null,
		lastError: row?.historian_last_error ?? null,
		failureCount: row?.historian_failure_count ?? 0,
	};
}
