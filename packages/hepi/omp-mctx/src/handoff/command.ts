import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionHeader,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { type ExtensionLifecycleContext, openTuiSurface, startSubagent } from "#host/pi-ext-shim";
import { getCompartments } from "#core/features/compartment-storage";
import { getMemoriesByProject } from "#core/features/memory/storage-memory";
import { getOrCreateSessionMeta } from "#core/features/storage";
import { getTagsBySession } from "#core/features/storage-tags";
import { resolveExecuteThreshold } from "#core/hooks/event-resolvers";
import { estimateTokens } from "#core/hooks/read-session-formatting";
import type { RegisterCtxWrapupDeps } from "../commands/ctx-wrapup";
import { runPiWrapup } from "../commands/ctx-wrapup";
import { sendCtxStatusMessage } from "../commands/pi-command-utils";
import { COMPACTION_OFF_COMMAND_UNAVAILABLE } from "../compaction-off-pi";
import { resolvePiUsableContextLimit } from "../pi-context-limit";
import { isPiRecompInFlight } from "../pi-recomp-runner";
import {
	acquireHandoffLease,
	getHandoffLease,
	HANDOFF_LEASE_RENEWAL_MS,
	releaseHandoffLease,
	renewHandoffLease,
} from "./lease";
import {
	assertPayloadLimit,
	buildCompletionPrompt,
	buildHandoffCompletionMessages,
	collectHandoffImages,
	detectConversationLanguage,
	fenceMatches,
	formatHandoffBusyWarning,
	formatHandoffWarning,
	HANDOFF_ATTEMPT_TYPE,
	HANDOFF_CONTEXT_TYPE,
	HANDOFF_RECENT_COUNT,
	HANDOFF_REQUEST_TYPE,
	HANDOFF_SYSTEM_GUARD,
	type HandoffAttemptRecord,
	type HandoffContextDetails,
	type HandoffFailureCategory,
	type HandoffProgressStage,
	type HandoffRequestRecord,
	type HandoffSourceContextSnapshot,
	type HandoffTerminalPhase,
	handoffContextContent,
	hashBytes,
	isHandoffProgressPhase,
	renderHandoffContextXml,
	validateHandoffSummary,
} from "./model";
import {
	appendRequestPhase,
	latestRequest,
	parseHandoffEntries,
	parseHandoffSessionFile,
	parseSessionFileEntries,
} from "./persistence";
import {
	createHandoffProgressComponent,
	type HandoffProgressState,
	tokenSummaryLine,
} from "./render";
import {
	assertProjectedContextLimit,
	freezeHandoffSnapshot,
	hashCompartments,
	hashMemories,
	hashToolInventory,
	modelVisibleBranchFingerprint,
} from "./snapshot";

export { HANDOFF_SYSTEM_GUARD };

const HANDOFF_HOST_ID = "pi-mctx-handoff";

export interface RegisterHandoffDeps extends RegisterCtxWrapupDeps {
	lifecycle?: ExtensionLifecycleContext | undefined;
}

export function registerHandoffCommand(pi: ExtensionAPI, deps: RegisterHandoffDeps): void {
	pi.registerCommand("handoff", {
		description:
			"Create a clean continuation session from a historian wrapup and current-model summary",
		handler: async (args, ctx) => {
			const runtime = {
				...(deps.resolveRuntimeDeps?.(ctx) ?? deps),
				lifecycle: deps.lifecycle,
			};
			await runHandoffCommand(pi, runtime, ctx, args);
		},
	});
}

type HandoffPublishContext = {
	sendMessage: (
		message: {
			customType: string;
			content: string;
			display: boolean;
			details: unknown;
		},
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	) => Promise<void>;
	sessionManager: ExtensionCommandContext["sessionManager"];
};

function hasHandoffSendMessage(
	ctx: ExtensionCommandContext,
): ctx is ExtensionCommandContext & HandoffPublishContext {
	return "sendMessage" in ctx && typeof (ctx as HandoffPublishContext).sendMessage === "function";
}

export async function publishHandoffContext(
	ctx: HandoffPublishContext,
	xml: string,
	details: HandoffContextDetails,
): Promise<void> {
	await ctx.sendMessage(
		{
			customType: HANDOFF_CONTEXT_TYPE,
			content: handoffContextContent({
				xml,
				images: details.images,
			}) as never,
			display: true,
			details,
		},
		{ triggerTurn: false },
	);
	persistHandoffSession(ctx.sessionManager);
}

export function branchHasHandoffContext(ctx: {
	sessionManager?: { getEntries?: () => unknown[] };
}): boolean {
	const entries = readSessionEntries(ctx);
	return parseHandoffEntries(entries).contexts.length > 0;
}

export async function runHandoffCommand(
	pi: ExtensionAPI,
	deps: RegisterHandoffDeps,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<void> {
	const warning = (content: { title: string; text: string }): void => {
		sendCtxStatusMessage(pi, {
			title: content.title,
			text: content.text,
			level: "warning",
		});
		ctx.ui.notify(content.text, "warning");
	};
	const pre = checkPreconditions(pi, deps, ctx, args);
	if (!pre.ok) {
		warning(pre.warning);
		return;
	}

	const sourcePath = ctx.sessionManager.getSessionFile();
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sourcePath || !sessionId) {
		warning({
			title: "/handoff",
			text: "No active session file is available for /handoff.",
		});
		return;
	}
	const parsedCurrent = parseHandoffEntries(readSessionEntries(ctx));
	const currentAttempt = latestAttempt(parsedCurrent.attempts);
	if (currentAttempt?.phase === "attempt-started") {
		await finalizeCurrentAttempt(pi, deps, ctx, currentAttempt, warning);
		return;
	}
	if (currentAttempt?.phase === "attempt-failed") {
		warning(
			formatHandoffWarning({
				outcome: "failed",
				stage: "replacement",
				reason: currentAttempt.reason ?? "this replacement already failed",
				requestId: currentAttempt.requestId,
				sourceAvailable: false,
				nextAction: "new-request",
			}),
		);
		return;
	}

	const holderId = randomUUID();
	const lease = acquireHandoffLease(deps.db, sessionId, holderId, "pending", "preparing");
	if (!lease) {
		const held = getHandoffLease(deps.db, sessionId);
		warning(
			formatHandoffBusyWarning({
				holderRequestId: held?.requestId ?? "unknown",
				stage: held?.stage ?? "unknown",
				expiresAt: held?.expiresAt ?? Date.now(),
				now: Date.now(),
			}),
		);
		return;
	}

	const abort = new AbortController();
	const renewal = setInterval(() => {
		renewHandoffLease(deps.db, sessionId, holderId, currentStage.stage);
	}, HANDOFF_LEASE_RENEWAL_MS);
	const currentStage: { stage: HandoffProgressStage } = { stage: "preparing" };
	const startedAt = Date.now();
	let progress: { update(next: HandoffProgressState): void; requestRender(): void } | undefined;
	try {
		await ctx.waitForIdle();
		if (ctx.hasPendingMessages()) {
			failAndWarn({
				pi,
				ctx,
				warning,
				request: undefined,
				phase: "failed",
				category: "busy",
				stage: "preparing",
				reason: "queued messages are waiting; wait for idle before /handoff",
			});
			return;
		}

		const surfaceTask = maybeOpenProgress(pi, ctx, abort, {
			stage: "preparing",
			startedAt,
			cancellable: true,
			now: Date.now(),
		}).then((opened) => {
			progress = opened;
		});

		const result = await executeHandoff({
			pi,
			deps,
			ctx,
			sourcePath,
			sessionId,
			abort,
			setStage(stage, extras) {
				currentStage.stage = stage;
				renewHandoffLease(deps.db, sessionId, holderId, stage);
				progress?.update({
					stage,
					...(extras?.model !== undefined ? { model: extras.model } : {}),
					...(extras?.tokenSummary !== undefined ? { tokenSummary: extras.tokenSummary } : {}),
					startedAt,
					cancellable: stage !== "finalizing" && stage !== "creating",
					now: Date.now(),
				});
				progress?.requestRender();
				sendCtxStatusMessage(pi, {
					title: "/handoff",
					text: extras?.status ?? stage,
					level: "info",
				});
			},
			warning,
		});
		await surfaceTask.catch(() => undefined);
		if (result === "cancelled") {
			abort.abort();
		}
	} finally {
		clearInterval(renewal);
		releaseHandoffLease(deps.db, sessionId, holderId);
		abort.abort();
	}
}

interface ExecuteArgs {
	pi: ExtensionAPI;
	deps: RegisterHandoffDeps;
	ctx: ExtensionCommandContext;
	sourcePath: string;
	sessionId: string;
	abort: AbortController;
	setStage: (
		stage: HandoffProgressStage,
		extras?:
			| {
					model?: string | undefined;
					tokenSummary?: string | undefined;
					status?: string | undefined;
			  }
			| undefined,
	) => void;
	warning: (content: { title: string; text: string }) => void;
}

async function executeHandoff(args: ExecuteArgs): Promise<"ok" | "cancelled"> {
	const { pi, ctx, warning } = args;
	const existing = latestRequest(parseHandoffEntries(readSessionEntries(ctx)).requests);
	if (existing && isHandoffProgressPhase(existing.phase)) {
		return resumeExisting(args, existing);
	}

	const requestId = randomUUID();
	const requested = writeRequest(pi, undefined, {
		requestId,
		phase: "requested",
		stage: "preparing",
		createdAt: new Date().toISOString(),
	});
	if (!requested.ok) {
		warning(
			formatHandoffWarning({
				outcome: "failed",
				stage: "persistence",
				reason: requested.reason,
				requestId,
				sourceAvailable: true,
				nextAction: "new-request",
			}),
		);
		return "ok";
	}

	return continueFromRequested(args, requested.record);
}

async function continueFromRequested(
	args: ExecuteArgs,
	requested: HandoffRequestRecord,
): Promise<"ok" | "cancelled"> {
	const { pi, deps, ctx, sourcePath, sessionId, abort, setStage, warning } = args;
	setStage("preparing", { status: "Preparing history" });
	if (abort.signal.aborted) {
		return cancel(args, requested);
	}
	const wrapup = await runPiWrapup(pi, deps, ctx, sessionId, HANDOFF_RECENT_COUNT);
	if (!wrapup.ok) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request: requested,
			phase: "failed",
			category: "historian",
			stage: "preparing",
			reason: wrapup.message,
		});
		return "ok";
	}

	setStage("freezing", { status: "Freezing context" });
	if (abort.signal.aborted) return cancel(args, requested);
	let snapshot: ReturnType<typeof freezeFromContext>;
	try {
		snapshot = freezeFromContext(deps, ctx, sessionId, sourcePath, pi.getAllTools());
	} catch (error) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request: requested,
			phase: "failed",
			category: "snapshot",
			stage: "freezing",
			reason: error instanceof Error ? error.message : String(error),
		});
		return "ok";
	}
	if (!snapshot.ok) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request: requested,
			phase: "failed",
			category: snapshot.reason.includes("budget") ? "budget" : "snapshot",
			stage: "freezing",
			reason: snapshot.reason,
		});
		return "ok";
	}
	const snapshotReady = writeRequest(pi, requested, {
		...requested,
		phase: "snapshot-ready",
		stage: "freezing",
		model: snapshot.snapshot.fence.model,
		snapshot: snapshot.snapshot,
		tokenCounts: snapshot.snapshot.tokens,
	});
	if (!snapshotReady.ok) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request: requested,
			phase: "failed",
			category: "persistence",
			stage: "freezing",
			reason: snapshotReady.reason,
		});
		return "ok";
	}
	return completeAndReplace(args, snapshotReady.record);
}

async function resumeExisting(
	args: ExecuteArgs,
	existing: HandoffRequestRecord,
): Promise<"ok" | "cancelled"> {
	const { pi, deps, ctx, sourcePath, sessionId, abort, warning } = args;
	if (existing.phase === "requested") {
		return continueFromRequested(args, existing);
	}

	const liveFence = freezeFromContext(deps, ctx, sessionId, sourcePath, pi.getAllTools());
	if (existing.phase === "snapshot-ready" || existing.phase === "summary-ready") {
		if (
			!liveFence.ok ||
			!existing.snapshot ||
			!fenceMatches(existing.snapshot.fence, liveFence.snapshot.fence)
		) {
			writeRequest(pi, existing, {
				...existing,
				phase: "superseded",
				stage: existing.stage,
				failureCategory: "stale",
				reason: "source context changed after the stored snapshot",
			});
			return executeHandoff(args);
		}
	}

	if (existing.phase === "snapshot-ready") {
		if (abort.signal.aborted) return cancel(args, existing);
		return completeAndReplace(args, existing);
	}
	if (existing.phase === "summary-ready" || existing.phase === "replacement-started") {
		const discovered = await discoverContinuations(ctx, sourcePath, existing.requestId);
		if (!discovered.ok) {
			failAndWarn({
				pi,
				ctx,
				warning,
				request: existing,
				phase: "failed",
				category: "recovery",
				stage: "creating",
				reason: discovered.reason,
			});
			return "ok";
		}
		if (discovered.switchTo) {
			await ctx.switchSession(discovered.switchTo);
			return "ok";
		}
		if (discovered.finalize) {
			await ctx.switchSession(discovered.finalize);
			return "ok";
		}
		return replaceSession(args, existing);
	}
	return "ok";
}

async function completeAndReplace(
	args: ExecuteArgs,
	request: HandoffRequestRecord,
): Promise<"ok" | "cancelled"> {
	const { pi, deps, ctx, abort, setStage, warning } = args;
	if (!request.snapshot) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request,
			phase: "failed",
			category: "snapshot",
			stage: "freezing",
			reason: "snapshot-ready request is missing snapshot bytes",
		});
		return "ok";
	}
	if (!deps.lifecycle) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request,
			phase: "failed",
			category: "configuration",
			stage: "summarizing",
			reason: "handoff completion is unavailable because the extension lifecycle is not started",
		});
		return "ok";
	}
	if (abort.signal.aborted) return cancel(args, request);

	const modelRef = `${ctx.model?.provider}/${ctx.model?.id}`;
	setStage("summarizing", {
		model: modelRef,
		tokenSummary: tokenSummaryLine({ tokenCounts: request.snapshot.tokens }),
		status: `Summarizing · ${modelRef}`,
	});
	const language = detectConversationLanguage(request.snapshot.recentMessages, deps.language);
	const prompt = buildCompletionPrompt({
		language,
		reserveTokens: request.snapshot.tokens.summaryReserve,
	});
	const resolvedModel = ctx.model;
	if (!resolvedModel) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request,
			phase: "failed",
			category: "configuration",
			stage: "summarizing",
			reason: "current model is not resolved",
		});
		return "ok";
	}
	const messages = buildHandoffCompletionMessages({
		sessionHistory: request.snapshot.sessionHistory,
		recentMessages: request.snapshot.recentMessages,
		prompt,
		model: {
			api: String(resolvedModel.api ?? ""),
			provider: String(resolvedModel.provider ?? ""),
			id: String(resolvedModel.id ?? ""),
		},
	});
	let completionText = "";
	let stopReason = "error";
	try {
		const handle = await startSubagent(deps.lifecycle, {
			mode: "completion",
			model: resolvedModel as never,
			thinkingLevel: (ctx.thinkingLevel ?? "off") as never,
			systemPrompt: ctx.getSystemPrompt(),
			prompt,
			messages,
		});
		const onAbort = (): void => {
			handle.cancel();
		};
		abort.signal.addEventListener("abort", onAbort, { once: true });
		const result = await handle.result;
		abort.signal.removeEventListener("abort", onAbort);
		if (result.status === "cancelled") return cancel(args, request);
		if (result.status !== "completed") {
			failAndWarn({
				pi,
				ctx,
				warning,
				request,
				phase: "failed",
				category: "completion",
				stage: "summarizing",
				reason: result.status === "failed" ? result.failure.message : "handoff completion failed",
			});
			return "ok";
		}
		completionText = result.output;
		stopReason = "stop";
	} catch (error) {
		if (abort.signal.aborted) return cancel(args, request);
		failAndWarn({
			pi,
			ctx,
			warning,
			request,
			phase: "failed",
			category: "completion",
			stage: "summarizing",
			reason: error instanceof Error ? error.message : String(error),
		});
		return "ok";
	}

	const invalid = validateHandoffSummary({
		text: completionText,
		stopReason,
		tokenCount: estimateTokens(completionText),
		budgetTokens: request.snapshot.tokens.summaryReserve,
	});
	if (invalid) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request,
			phase: "failed",
			category: invalid.includes("above") ? "budget" : "completion",
			stage: "summarizing",
			reason: invalid,
		});
		return "ok";
	}
	const summaryReady = writeRequest(pi, request, {
		...request,
		phase: "summary-ready",
		stage: "summarizing",
		summary: completionText,
	});
	if (!summaryReady.ok) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request,
			phase: "failed",
			category: "persistence",
			stage: "summarizing",
			reason: summaryReady.reason,
		});
		return "ok";
	}
	if (abort.signal.aborted) return cancel(args, summaryReady.record);
	return replaceSession(args, summaryReady.record);
}

async function replaceSession(
	args: ExecuteArgs,
	request: HandoffRequestRecord,
): Promise<"ok" | "cancelled"> {
	const { pi, ctx, sourcePath, abort, setStage, warning } = args;
	if (!request.snapshot || !request.summary) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request,
			phase: "failed",
			category: "snapshot",
			stage: "creating",
			reason: "replacement is missing snapshot or summary",
		});
		return "ok";
	}
	if (hasExternalBranchDrift(ctx, request)) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request,
			phase: "interrupted",
			category: "stale",
			stage: "creating",
			reason: "the source branch changed during handoff",
		});
		return "ok";
	}

	setStage("creating", { status: "Creating continuation" });
	const started = writeRequest(pi, request, {
		...request,
		phase: "replacement-started",
		stage: "creating",
	});
	if (!started.ok) {
		failAndWarn({
			pi,
			ctx,
			warning,
			request,
			phase: "failed",
			category: "persistence",
			stage: "creating",
			reason: started.reason,
		});
		return "ok";
	}
	setStage("finalizing", { status: "Finalizing…" });
	try {
		const generatedAt = new Date().toISOString();
		const xml = renderHandoffContextXml({
			sessionId: request.snapshot.fence.sessionId,
			model: request.snapshot.fence.model,
			generatedAt,
			sessionHistory: request.snapshot.sessionHistory,
			recentMessages: request.snapshot.recentMessages,
			summary: request.summary,
		});
		const details: HandoffContextDetails = {
			requestId: request.requestId,
			sourcePath,
			sourceSessionId: request.snapshot.fence.sessionId,
			projectIdentity: request.snapshot.fence.projectIdentity,
			model: request.snapshot.fence.model,
			thinkingLevel: request.snapshot.fence.thinkingLevel,
			generatedAt,
			fence: request.snapshot.fence,
			tokens: request.snapshot.tokens,
			images: collectHandoffImages(request.snapshot.recentMessages),
		};
		const toolSnapshot = pi.getAllTools();
		const created = await ctx.newSession({
			parentSession: sourcePath,
			setup: async (sessionManager) => {
				sessionManager.appendCustomEntry(HANDOFF_ATTEMPT_TYPE, {
					requestId: request.requestId,
					phase: "attempt-started",
					sourcePath,
					expectedContextHash: hashBytes(xml),
					startedAt: generatedAt,
				} satisfies HandoffAttemptRecord);
				persistHandoffSession(sessionManager);
			},
			withSession: async (replacement) => {
				const destWarn = (reason: string, nextAction: "resume" | "new-request"): void => {
					replacement.ui.notify(
						formatHandoffWarning({
							outcome: "failed",
							stage: "replacement",
							reason,
							requestId: request.requestId,
							sourceAvailable: true,
							nextAction,
						}).text,
						"warning",
					);
				};
				const writable = replacement.sessionManager as SessionManager;
				const prefixTokens =
					estimateTokens(replacement.getSystemPrompt()) +
					estimateTokens(JSON.stringify(toolSnapshot));
				const drift = assertProjectedContextLimit({
					snapshot: request.snapshot as HandoffSourceContextSnapshot,
					summary: request.summary ?? "",
					ceiling: request.snapshot?.tokens.executeCeiling ?? 0,
					prefixTokens,
				});
				if (drift) {
					writable.appendCustomEntry(HANDOFF_ATTEMPT_TYPE, {
						requestId: request.requestId,
						phase: "attempt-failed",
						sourcePath,
						startedAt: generatedAt,
						category: "budget",
						reason: drift,
					} satisfies HandoffAttemptRecord);
					persistHandoffSession(writable);
					destWarn(drift, "new-request");
					return;
				}
				const payloadError = assertPayloadLimit({ xml, details }, "Handoff Context");
				if (payloadError) {
					writable.appendCustomEntry(HANDOFF_ATTEMPT_TYPE, {
						requestId: request.requestId,
						phase: "attempt-failed",
						sourcePath,
						startedAt: generatedAt,
						category: "budget",
						reason: payloadError,
					} satisfies HandoffAttemptRecord);
					persistHandoffSession(writable);
					destWarn(payloadError, "new-request");
					return;
				}
				await publishHandoffContext(replacement, xml, details);
			},
		});
		if (created.cancelled && ctx.sessionManager.getSessionFile() === sourcePath) {
			ctx.ui.notify(
				formatHandoffWarning({
					outcome: "failed",
					stage: "replacement",
					reason:
						"session replacement was cancelled after replacement-started; rerun /handoff to retry",
					requestId: request.requestId,
					sourceAvailable: true,
					nextAction: "resume",
				}).text,
				"warning",
			);
		}
	} catch (error) {
		ctx.ui.notify(
			formatHandoffWarning({
				outcome: "failed",
				stage: "replacement",
				reason: error instanceof Error ? error.message : String(error),
				requestId: request.requestId,
				sourceAvailable: true,
				nextAction: "resume",
			}).text,
			"warning",
		);
	}
	void abort;
	return "ok";
}

async function finalizeCurrentAttempt(
	pi: ExtensionAPI,
	deps: RegisterHandoffDeps,
	ctx: ExtensionCommandContext,
	attempt: HandoffAttemptRecord,
	warning: (content: { title: string; text: string }) => void,
): Promise<void> {
	const source = parseHandoffSessionFile(attempt.sourcePath);
	const request = latestRequest(source.requests);
	if (
		!request ||
		request.requestId !== attempt.requestId ||
		request.phase !== "replacement-started"
	) {
		warning(
			formatHandoffWarning({
				outcome: "failed",
				stage: "recovery",
				reason: "the unfinished attempt does not match a replacement-started source request",
				requestId: attempt.requestId,
				sourceAvailable: true,
				nextAction: "new-request",
			}),
		);
		return;
	}
	if (!request.snapshot || !request.summary) {
		warning(
			formatHandoffWarning({
				outcome: "failed",
				stage: "recovery",
				reason: "the source request is missing snapshot or summary bytes",
				requestId: attempt.requestId,
				sourceAvailable: true,
				nextAction: "new-request",
			}),
		);
		return;
	}
	const sourceEntries = parseSessionFileEntries(attempt.sourcePath);
	const liveFingerprint = modelVisibleBranchFingerprint(sourceEntries);
	const liveMemories = hashMemories(getMemoriesByProject(deps.db, ctx.cwd));
	const liveCompartments = hashCompartments(
		getCompartments(deps.db, request.snapshot.fence.sessionId),
	);
	if (
		liveFingerprint !== request.snapshot.fence.branchFingerprint ||
		liveMemories !== request.snapshot.fence.memoryRevision ||
		liveCompartments !== request.snapshot.fence.compartmentRevision ||
		ctx.cwd !== request.snapshot.fence.projectIdentity
	) {
		const writable = ctx.sessionManager as SessionManager;
		writable.appendCustomEntry(HANDOFF_ATTEMPT_TYPE, {
			...attempt,
			phase: "attempt-failed",
			category: "stale",
			reason: "source fence no longer matches this unfinished attempt",
		} satisfies HandoffAttemptRecord);
		persistHandoffSession(writable);
		warning(
			formatHandoffWarning({
				outcome: "failed",
				stage: "recovery",
				reason: "source fence no longer matches this unfinished attempt",
				requestId: attempt.requestId,
				sourceAvailable: true,
				nextAction: "new-request",
			}),
		);
		return;
	}
	const generatedAt = new Date().toISOString();
	const xml = renderHandoffContextXml({
		sessionId: request.snapshot.fence.sessionId,
		model: request.snapshot.fence.model,
		generatedAt,
		sessionHistory: request.snapshot.sessionHistory,
		recentMessages: request.snapshot.recentMessages,
		summary: request.summary,
	});
	if (attempt.expectedContextHash && attempt.expectedContextHash !== hashBytes(xml)) {
		const writable = ctx.sessionManager as SessionManager;
		writable.appendCustomEntry(HANDOFF_ATTEMPT_TYPE, {
			...attempt,
			phase: "attempt-failed",
			category: "recovery",
			reason: "rebuilt Handoff Context does not match the expected hash",
		} satisfies HandoffAttemptRecord);
		persistHandoffSession(writable);
		warning(
			formatHandoffWarning({
				outcome: "failed",
				stage: "recovery",
				reason: "rebuilt Handoff Context does not match the expected hash",
				requestId: attempt.requestId,
				sourceAvailable: true,
				nextAction: "new-request",
			}),
		);
		return;
	}
	const details: HandoffContextDetails = {
		requestId: request.requestId,
		sourcePath: attempt.sourcePath,
		sourceSessionId: request.snapshot.fence.sessionId,
		projectIdentity: request.snapshot.fence.projectIdentity,
		model: request.snapshot.fence.model,
		thinkingLevel: request.snapshot.fence.thinkingLevel,
		generatedAt,
		fence: request.snapshot.fence,
		tokens: request.snapshot.tokens,
		images: collectHandoffImages(request.snapshot.recentMessages),
	};
	if (!hasHandoffSendMessage(ctx)) {
		warning(
			formatHandoffWarning({
				outcome: "failed",
				stage: "recovery",
				reason: "continuation session cannot publish Handoff Context",
				requestId: attempt.requestId,
				sourceAvailable: true,
				nextAction: "resume",
			}),
		);
		return;
	}
	await publishHandoffContext(ctx, xml, details);
	void pi;
}

export async function discoverContinuations(
	ctx: ExtensionCommandContext,
	sourcePath: string,
	requestId: string,
): Promise<
	| { ok: true; switchTo?: string | undefined; finalize?: string | undefined }
	| { ok: false; reason: string }
> {
	const listed = await listSiblingSessions(ctx);
	const valid: string[] = [];
	const unfinished: string[] = [];
	const failed: string[] = [];
	for (const info of listed) {
		if (info.parentSessionPath !== sourcePath) continue;
		const parsed = parseHandoffSessionFile(info.path);
		const contexts = parsed.contexts.filter((item) => item.requestId === requestId);
		const attempts = parsed.attempts.filter((item) => item.requestId === requestId);
		if (contexts.length > 1) {
			return { ok: false, reason: "multiple Handoff Context entries share this request" };
		}
		if (contexts.length === 1) {
			valid.push(info.path);
			continue;
		}
		const hasFailed = attempts.some((item) => item.phase === "attempt-failed");
		const hasStarted = attempts.some((item) => item.phase === "attempt-started");
		if (hasFailed) failed.push(info.path);
		else if (hasStarted) unfinished.push(info.path);
	}
	if (valid.length > 1 || unfinished.length > 1) {
		return {
			ok: false,
			reason: "multiple continuation candidates exist for this request",
		};
	}
	const switchTo = valid[0];
	if (valid.length === 1 && switchTo !== undefined) return { ok: true, switchTo };
	const finalize = unfinished[0];
	if (unfinished.length === 1 && finalize !== undefined) return { ok: true, finalize };
	if (failed.length > 0) {
		return { ok: false, reason: "the previous replacement attempt already failed" };
	}
	return { ok: true };
}

export function checkPreconditions(
	pi: ExtensionAPI,
	deps: RegisterHandoffDeps,
	ctx: ExtensionCommandContext,
	args: string,
): { ok: true } | { ok: false; warning: { title: string; text: string } } {
	const fail = (reason: string) => ({
		ok: false as const,
		warning: formatHandoffWarning({
			outcome: "failed",
			stage: "configuration",
			reason,
			sourceAvailable: true,
			nextAction: "new-request",
		}),
	});
	if (args.trim().length > 0) {
		return fail("/handoff does not accept arguments");
	}
	if (deps.compactionOff) {
		return fail(COMPACTION_OFF_COMMAND_UNAVAILABLE);
	}
	if (!sessionIsPersisted(ctx.sessionManager)) {
		return fail("/handoff requires a persisted session");
	}
	const sessionId = ctx.sessionManager.getSessionId();
	if (getOrCreateSessionMeta(deps.db, sessionId).isSubagent) {
		return fail("/handoff is only available in primary sessions");
	}
	if (!deps.historianModel) {
		return fail("historian model is not configured");
	}
	if (!ctx.model) {
		return fail("the current primary model is not configured");
	}
	if (isPiRecompInFlight(sessionId)) {
		return fail("a recomp or session upgrade is already running");
	}
	void pi;
	return { ok: true };
}

function freezeFromContext(
	deps: RegisterHandoffDeps,
	ctx: ExtensionCommandContext,
	sessionId: string,
	sourcePath: string,
	tools: readonly unknown[] = [],
): ReturnType<typeof freezeHandoffSnapshot> {
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
	const usableLimit =
		resolvePiUsableContextLimit({
			rawContextWindow: ctx.getContextUsage?.()?.contextWindow ?? ctx.model?.contextWindow,
			model: ctx.model,
		}) ?? 128_000;
	const executePercentage = resolveExecuteThreshold(
		deps.executeThresholdPercentage ?? 65,
		model,
		65,
		{
			tokensConfig: deps.executeThresholdTokens,
			contextLimit: usableLimit,
			sessionId,
		},
	);
	const executeCeiling = Math.floor((usableLimit * executePercentage) / 100);
	const prefixTokens =
		estimateTokens(ctx.getSystemPrompt()) + estimateTokens(JSON.stringify(tools));
	const memories = getMemoriesByProject(deps.db, ctx.cwd);
	return freezeHandoffSnapshot({
		sessionId,
		sessionPath: sourcePath,
		projectIdentity: ctx.cwd,
		model,
		thinkingLevel: String(ctx.thinkingLevel ?? "off"),
		systemPrompt: ctx.getSystemPrompt(),
		toolInventory: hashToolInventory(tools),
		memoryRevision: hashMemories(memories),
		branchFingerprint: modelVisibleBranchFingerprint(readSessionEntries(ctx)),
		usableLimit,
		executeCeiling,
		prefixTokens,
		compartments: getCompartments(deps.db, sessionId) ?? [],
		entries: readSessionEntries(ctx),
		tags: getTagsBySession(deps.db, sessionId) ?? [],
	});
}

function persistHandoffSession(sessionManager: {
	getSessionFile(): string | undefined;
	getHeader(): SessionHeader | null;
	getEntries(): readonly unknown[];
}): void {
	const path = sessionManager.getSessionFile();
	if (!path) throw new Error("destination session has no file path");
	const header = sessionManager.getHeader();
	if (!header) throw new Error("destination session has no header");
	const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
	writeFileSync(path, `${lines.join("\n")}\n`);
	(sessionManager as { flushed?: boolean }).flushed = true;
}

function writeRequest(
	pi: ExtensionAPI,
	current: HandoffRequestRecord | undefined,
	next: HandoffRequestRecord,
): { ok: true; record: HandoffRequestRecord } | { ok: false; reason: string } {
	const reduced = appendRequestPhase(current, next);
	if (!reduced.ok) return reduced;
	pi.appendEntry(HANDOFF_REQUEST_TYPE, reduced.record);
	return reduced;
}

function failAndWarn(args: {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	warning: (content: { title: string; text: string }) => void;
	request: HandoffRequestRecord | undefined;
	phase: HandoffTerminalPhase;
	category: HandoffFailureCategory;
	stage: string;
	reason: string;
}): void {
	if (args.request) {
		writeRequest(args.pi, args.request, {
			...args.request,
			phase: args.phase,
			failureCategory: args.category,
			reason: args.reason,
		});
	}
	args.warning(
		formatHandoffWarning({
			outcome: args.phase,
			stage: args.stage,
			reason: args.reason,
			requestId: args.request?.requestId,
			model: args.request?.model,
			sourceAvailable: true,
			nextAction: args.phase === "superseded" ? "resume" : "new-request",
		}),
	);
}

function cancel(args: ExecuteArgs, request: HandoffRequestRecord): "cancelled" {
	failAndWarn({
		pi: args.pi,
		ctx: args.ctx,
		warning: args.warning,
		request,
		phase: "cancelled",
		category: "cancelled",
		stage: request.stage,
		reason: "handoff was cancelled",
	});
	return "cancelled";
}

function hasExternalBranchDrift(
	ctx: ExtensionCommandContext,
	request: HandoffRequestRecord,
): boolean {
	if (!request.snapshot) return false;
	return (
		modelVisibleBranchFingerprint(readSessionEntries(ctx)) !==
		request.snapshot.fence.branchFingerprint
	);
}

function readSessionEntries(ctx: {
	sessionManager?: {
		getEntries?: (() => unknown[]) | undefined;
		getBranch?: (() => { entries?: unknown[] } | unknown[]) | undefined;
	};
}): unknown[] {
	const manager = ctx.sessionManager;
	if (!manager) return [];
	if (typeof manager.getEntries === "function") {
		const entries = manager.getEntries();
		if (Array.isArray(entries)) return entries;
	}
	if (typeof manager.getBranch === "function") {
		const branch = manager.getBranch();
		if (Array.isArray(branch)) return branch;
		if (branch && typeof branch === "object" && Array.isArray(branch.entries)) {
			return branch.entries;
		}
	}
	return [];
}

function latestAttempt(records: readonly HandoffAttemptRecord[]): HandoffAttemptRecord | undefined {
	return records.length === 0 ? undefined : records[records.length - 1];
}

function sessionIsPersisted(manager: ExtensionCommandContext["sessionManager"]): boolean {
	const maybe = manager as { isPersisted?: () => boolean };
	if (typeof maybe.isPersisted === "function") return maybe.isPersisted();
	const path = manager.getSessionFile();
	return typeof path === "string" && path.length > 0;
}

async function listSiblingSessions(
	ctx: ExtensionCommandContext,
): Promise<Array<{ path: string; parentSessionPath?: string }>> {
	const local = ctx.sessionManager as {
		list?:
			| ((cwd: string) => Promise<Array<{ path: string; parentSessionPath?: string }>>)
			| undefined;
	};
	if (typeof local.list === "function") return local.list(ctx.cwd);
	return SessionManager.list(ctx.cwd);
}

async function maybeOpenProgress(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	abort: AbortController,
	initial: HandoffProgressState,
): Promise<{ update(next: HandoffProgressState): void; requestRender(): void } | undefined> {
	if (ctx.mode !== "tui") return undefined;
	let view: { update(next: HandoffProgressState): void; requestRender(): void } | undefined;
	void openTuiSurface(pi, ctx, {
		hostId: HANDOFF_HOST_ID,
		signal: abort.signal,
		maxPending: 1,
		create(surface) {
			const component = createHandoffProgressComponent(initial, surface.theme);
			view = {
				update: (next) => component.update(next),
				requestRender: () => surface.requestRender(),
			};
			return component;
		},
	}).then((result) => {
		if (result.status === "aborted" && !abort.signal.aborted) abort.abort();
	});
	return view;
}
