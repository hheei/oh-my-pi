import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	Ellipsis,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { estimatePiPrefixTokens } from "#host/pi-ext-shim";
import { asPromptText } from "../host/omp";
import { readAgentMemoryStatus, type AgentMemoryStatus } from "../agentmemory/status";
import { getCompartments } from "#core/features/compartment-storage";
import { getMemoryCount } from "#core/features/memory/storage-memory";
import { parseCacheTtl } from "#core/features/scheduler";
import type { ContextDatabase } from "#core/features/storage";
import { readSessionMeta } from "#core/features/storage-meta";
import { getDefaultSessionMeta } from "#core/features/storage-meta-shared";
import {
	EMERGENCY_DRAIN_FAILURE_BACKOFF_MS,
	getHistorianFailureState,
	getOverflowState,
	getSessionWorkMetrics,
	loadProtectedTailMeta,
} from "#core/features/storage-meta-persisted";
import { getNotes } from "#core/features/storage-notes";
import { getTagsBySession } from "#core/features/storage-tags";
import { resolveExecuteThresholdDetail } from "#core/hooks/event-resolvers";
import { computeM0BlockTokens } from "#core/hooks/m0-token-breakdown";
import { countCompartmentsNeedingUpgrade } from "#core/hooks/upgrade-reminder";
import {
	getLatestMeaningfulHistorianRun,
	type HistorianRunSummary,
} from "#core/features/storage-historian-runs";
import type { RecompProgress } from "#core/hooks/compartment-runner-types";
import { formatThresholdPercent } from "#core/shared/format-threshold";
import packageJson from "../../package.json";
import { resolveSessionId } from "../commands/pi-command-utils";
import { resolvePiUsableContextLimit } from "../pi-context-limit";
import { isPiRecompInFlight } from "../pi-recomp-runner";

// Keep category colors stable across the TUI and headless semantic sections.
const COLORS = {
	system: "#c084fc", // Purple
	docs: "#22d3ee", // Cyan — <project-docs>
	compartments: "#60a5fa", // Blue
	memories: "#34d399", // Green
	profile: "#a3e635", // Lime — <user-profile>
	conversation: "#f87171", // Red
	toolCalls: "#fb923c", // Orange
	recalls: "#a78bfa", // Violet
	unattributed: "#94a3b8", // Slate
	toolDefs: "#f472b6", // Pink
};

/** Refresh cadence while dialog is open. */
const REFRESH_INTERVAL_MS = 1000;

export interface StatusDialogDeps {
	db: ContextDatabase;
	projectIdentity: string;
	protectedTags?: number | undefined;
	executeThresholdPercentage?: number | { default: number;[modelKey: string]: number } | undefined;
	historyBudgetPercentage?: number | undefined;
	injectionBudgetTokens?: number | undefined;
	executeThresholdTokens?:
	| {
		default?: number | undefined;
		[modelKey: string]: number | undefined;
	}
	| undefined;
	/** Existing process-local progress records, when the active caller owns one. */
	/** Optional public branch identity; defaults to the durable main branch when unavailable. */
	resolveBranchId?: ((ctx: ExtensionCommandContext) => string | undefined) | undefined;
	recompProgressBySession?: ReadonlyMap<string, RecompProgress> | undefined;
}

export interface StatusSection {
	title: string;
	items: Array<{ label: string; value: string }>;
}

export interface StatusSnapshot {
	sessionId: string;
	projectIdentity: string;
	usagePercentage: number;
	inputTokens: number;
	tokenBreakdownAvailable: boolean;
	systemPromptTokens: number;
	compartmentCount: number;
	memoryCount: number;
	memoryBlockCount: number;
	sessionNoteCount: number;
	readySmartNoteCount: number;
	pendingOpsCount: number;
	historianRunning: boolean;
	historianFailureCount: number;
	historianLastFailureAt: number | null;
	historianLastError: string | null;
	historianBackoffAt?: number | null;
	historianLatestSuccess?: HistorianRunSummary | null;
	cacheTtl: string;
	lastResponseTime: number;
	cacheRemainingMs: number;
	cacheExpired: boolean;
	lastNudgeTokens: number;
	lastNudgeBand: string;
	lastTransformError: string | null;
	isSubagent: boolean;
	contextLimit: number;
	executeThreshold: number;
	/** Which config source produced `executeThreshold` (tokens vs percentage). */
	executeThresholdMode: "percentage" | "tokens";
	/** True when `executeThreshold` was clamped down from a higher configured value (#241). */
	executeThresholdClamped?: boolean | undefined;
	/** Raw configured value before clamping, for showing the math in the clamp note. */
	executeThresholdConfigured?: number | undefined;
	protectedTagCount: number;
	historyBlockTokens: number;
	compressionBudget: number | null;
	compressionUsage: string | null;
	activeTags: number;
	droppedTags: number;
	totalTags: number;
	activeBytes: number;
	compartmentTokens: number;
	factTokens: number;
	memoryTokens: number;
	docsTokens: number;
	profileTokens: number;
	conversationTokens: number;
	toolCallTokens: number;
	/** Tokens attributed to exact active Recall Event identities. */
	recallTokens: number;
	/** Explicit provider/framing remainder after semantic attribution. */
	unattributedTokens: number;
	/** Attribution is newer/larger than live kernel usage; wait for next transform. */
	tokenBreakdownRefreshPending: boolean;
	toolDefinitionTokens: number;
	newWorkTokens: number;
	totalInputTokens: number;
	/** Compartments still needing a v2 upgrade (legacy or tierless). */
	upgradeNeededCount: number;
	/** A detached /ctx-recomp or /ctx-session-upgrade is running in background. */
	recompInFlight: boolean;
	/** Existing process-local typed progress, when available to this status call. */
	recompProgress?: RecompProgress | null;
	/** Generic public async jobs, supplementary to mctx domain progress. */
	asyncJobsRunning?: number;
	diagnostics: string[];
	agentMemory: AgentMemoryStatus;
}

export async function showStatusDialog(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: StatusDialogDeps,
	snapshot?: StatusSnapshot,
): Promise<void> {
	const sessionId = resolveSessionId(ctx);
	if (!sessionId) throw new Error("No active Pi session is available.");

	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) =>
			new StatusDialogComponent({
				pi,
				ctx,
				deps,
				sessionId,
				snapshot,
				theme,
				tui,
				done,
			}),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: 78 },
		},
	);
}

interface StatusDialogProps {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	deps: StatusDialogDeps;
	sessionId: string;
	snapshot?: StatusSnapshot;
	theme: Theme;
	tui: TUI;
	done: (value: undefined) => void;
}

/**
 * Custom Component implementation:
 *  - implements its own handleInput so Escape / Enter / Ctrl+C close cleanly
 *  - draws a Unicode rounded-corner border using theme borderMuted color
 *  - rebuilds detail and re-renders on a 1s timer so live values stay current
 *  - cleans up timer on close
 */
class StatusDialogComponent implements Component {
	private readonly props: StatusDialogProps;
	private detail: StatusSnapshot;
	private refreshTimer: Timer | null = null;
	private closed = false;
	private sectionIndex = 0;
	private detailOffset = 0;

	constructor(props: StatusDialogProps) {
		this.props = props;
		this.detail = props.snapshot ?? collectStatusSnapshot(props.pi, props.ctx, props.deps, props.sessionId);
		this.refreshTimer = props.ctx.setInterval(() => {
			if (this.closed) return;
			this.detail = collectStatusSnapshot(
				this.props.pi,
				this.props.ctx,
				this.props.deps,
				this.props.sessionId,
			);
			this.props.tui.requestRender();
		}, REFRESH_INTERVAL_MS);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) {
			this.close();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right")) return this.moveSection(1);
		if (matchesKey(data, "left")) return this.moveSection(-1);
		if (matchesKey(data, "down") || data === "j") return this.moveDetail(1);
		if (matchesKey(data, "up") || data === "k") this.moveDetail(-1);
	}

	private moveSection(delta: number): void {
		const sectionCount = buildStatusSections(this.detail).length;
		this.sectionIndex = (this.sectionIndex + delta + sectionCount) % sectionCount;
		this.detailOffset = 0;
		this.props.tui.requestRender();
	}

	private moveDetail(delta: number): void {
		const count = buildStatusSections(this.detail)[this.sectionIndex]?.items.length ?? 0;
		if (count === 0) return;
		this.detailOffset = Math.max(0, Math.min(this.detailOffset + delta, count - 1));
		this.props.tui.requestRender();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimer) {
			this.props.ctx.clearTimer(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.props.done(undefined);
	}

	invalidate(): void { }

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		return drawBorder(renderInner(this.detail, this.props.theme, innerWidth, this.sectionIndex, this.detailOffset), width, this.props.theme);
	}

	dispose(): void {
		if (this.refreshTimer) {
			this.props.ctx.clearTimer(this.refreshTimer);
			this.refreshTimer = null;
		}
	}
}

function renderInner(s: StatusSnapshot, theme: Theme, innerWidth: number, sectionIndex: number, detailOffset = 0): string[] {
	const sections = buildStatusSections(s);
	const selectedIndex = Math.max(0, Math.min(sectionIndex, sections.length - 1));
	const section = sections[selectedIndex];
	const pctColor = s.usagePercentage >= 80 ? "error" : s.usagePercentage >= 65 ? "warning" : "accent";
	const lines: string[] = [
		`${theme.fg("accent", theme.bold("⚡ Magic Context Status"))}   ${theme.fg("muted", `v${packageJson.version}`)}`,
		"",
		`${theme.fg("muted", `${selectedIndex + 1}/${sections.length}`)} ${theme.bold(section.title)}`,
	];
	if (section.title === "Summary") {
		lines.push(`Context  ${theme.fg(pctColor, theme.bold(`${s.usagePercentage.toFixed(1)}%`))} · ${fmt(s.inputTokens)} / ${s.contextLimit > 0 ? fmt(s.contextLimit) : "?"} tokens`, `Work tokens ${fmt(s.newWorkTokens)} new · ${fmt(s.totalInputTokens)} total input`, renderBar(s, innerWidth));
		for (const segment of breakdownSegments(s)) {
			const pct = s.inputTokens > 0 ? `${((segment.tokens / s.inputTokens) * 100).toFixed(1)}%` : "—";
			lines.push(`${colorHex(segment.color, `${segment.label}${segment.detail ? ` ${segment.detail}` : ""}`)}   ${theme.fg("muted", `${fmt(segment.tokens)} (${pct})`)}`);
		}
		lines.push("");
	}
	const offset = Math.max(0, Math.min(detailOffset, Math.max(0, section.items.length - 1)));
	if (offset > 0) lines.push(theme.fg("muted", `… ${offset}/${section.items.length} earlier items · Up/k to reveal`));
	for (const item of section.items.slice(offset)) {
		if (section.title === "Memory" && item.label.startsWith("Recall ")) lines.push(theme.fg("muted", `${item.label}:`), `  ${item.value}`);
		else lines.push(`${theme.fg("muted", `${item.label}:`)} ${item.value}`);
	}
	lines.push("", theme.fg("muted", "Tab/←/→ sections · ↑/↓ or j/k detail · Escape/Return close"));
	return lines;
}

/** Wrap inner lines with a Unicode rounded-corner border. */
function drawBorder(inner: string[], width: number, theme: Theme): string[] {
	const innerWidth = Math.max(20, width - 4);
	const border = (s: string) => theme.fg("borderMuted", s);
	const out: string[] = [border(`╭${"─".repeat(innerWidth + 2)}╮`)];
	for (const raw of inner) {
		const line = truncateToWidth(raw, innerWidth, Ellipsis.Ascii);
		out.push(`${border("│")} ${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))} ${border("│")}`);
	}
	out.push(border(`╰${"─".repeat(innerWidth + 2)}╯`));
	return out;
}

export function collectStatusSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: StatusDialogDeps,
	sessionId: string,
): StatusSnapshot {
	const diagnostics: string[] = [];
	const usage = (() => {
		try {
			return ctx.getContextUsage?.();
		} catch {
			diagnostics.push("Kernel usage unavailable");
			return undefined;
		}
	})();
	const optional = <T>(label: string, fn: () => T, fallback: T): T => {
		try {
			return fn();
		} catch {
			diagnostics.push(`${label} unavailable`);
			return fallback;
		}
	};
	const meta = optional("Session metadata", () => readSessionMeta(deps.db, sessionId), undefined) ?? getDefaultSessionMeta(sessionId);
	const inputTokens = typeof usage?.tokens === "number" ? usage.tokens : meta.lastInputTokens;
	const historianFailure = optional("Historian failure state", () => getHistorianFailureState(deps.db, sessionId), {
		failureCount: 0,
		lastError: null,
		lastFailureAt: null,
	});
	const historianLatestSuccess = optional(
		"Historian telemetry",
		() => getLatestMeaningfulHistorianRun(deps.db, sessionId),
		null,
	);
	const historianBackoffAt = (() => {
		try {
			const at = loadProtectedTailMeta(deps.db, sessionId).historianDrainFailureAt;
			return at > 0 ? at : null;
		} catch {
			diagnostics.push("Historian backoff unavailable");
			return null;
		}
	})();
	const progressCandidate = deps.recompProgressBySession?.get(sessionId) ?? null;
	const recompProgress =
		progressCandidate === null ||
			(progressCandidate.kind !== undefined && progressCandidate.kind !== "recomp" && progressCandidate.kind !== "upgrade")
			? null
			: progressCandidate;
	const progressRunning =
		recompProgress !== null &&
		recompProgress.phase !== "done" &&
		recompProgress.phase !== "failed" &&
		recompProgress.phase !== "skipped";
	const asyncJobsRunning = optional(
		"Async job state",
		() => ctx.getAsyncJobSnapshot?.()?.running.length ?? 0,
		0,
	);
	let detectedContextLimit: number | undefined;
	try {
		const detected = getOverflowState(deps.db, sessionId).detectedContextLimit;
		if (detected > 0) detectedContextLimit = detected;
	} catch {
		diagnostics.push("Context limit fallback in use");
	}
	const contextLimit =
		usage?.contextWindow ??
		resolvePiUsableContextLimit({
			rawContextWindow: ctx.model?.contextWindow,
			model: ctx.model,
			detectedContextLimit,
		}) ??
		(meta.lastContextPercentage > 0 ? Math.round(inputTokens / (meta.lastContextPercentage / 100)) : 0);
	const usagePercentage =
		typeof usage?.percent === "number"
			? usage.percent
			: contextLimit > 0 && inputTokens > 0
				? (inputTokens / contextLimit) * 100
				: meta.lastContextPercentage;

	const compartments = optional("Compartments", () => getCompartments(deps.db, sessionId), []);
	const metaRow = optional("Session detail metadata", () => readSessionMetaRow(deps.db, sessionId), undefined);
	const memoryBlockCount = Number(metaRow?.memory_block_count ?? 0);

	// v2 m[0] per-block attribution via the shared core helper.
	const m0Bytes = metaRow?.cached_m0_bytes;
	const m0Text = m0Bytes instanceof Uint8Array ? Buffer.from(m0Bytes).toString("utf8") : typeof m0Bytes === "string" ? m0Bytes : "";
	const tokenizer = new Tokenizer(ctx.model);
	const m0Blocks = optional("Token attribution", () => computeM0BlockTokens(deps.db, sessionId, {
		m0Text,
		projectIdentity: deps.projectIdentity,
		injectionBudgetTokens: deps.injectionBudgetTokens,
		memoryBlockCount,
		countTokens: text => tokenizer.countTokens(text),
	}), { compartmentTokens: 0, factTokens: 0, memoryTokens: 0, muralTokens: 0, docsTokens: 0, profileTokens: 0 });
	const compartmentTokens = m0Blocks.compartmentTokens;
	const factTokens = m0Blocks.factTokens;
	const memoryTokens = m0Blocks.memoryTokens + m0Blocks.muralTokens;
	const docsTokens = m0Blocks.docsTokens;
	const profileTokens = m0Blocks.profileTokens;

	// On Pi we don't persist system_prompt_tokens (no
	// experimental.chat.system.transform hook). Compute it on demand from
	// ctx.getSystemPrompt() when available; fall back to the stored value
	// so the dialog still has a sensible number outside command context.
	let systemPrompt: string | undefined;
	try {
		const sysPrompt = typeof ctx.getSystemPrompt === "function" ? asPromptText(ctx.getSystemPrompt()) : "";
		if (sysPrompt.length > 0) systemPrompt = sysPrompt;
	} catch {
		diagnostics.push("System prompt unavailable");
	}
	const tags = optional("Tag state", () => getTagsBySession(deps.db, sessionId), []);
	const activeTags = tags.filter((tag) => tag.status === "active");
	const droppedTags = tags.filter((tag) => tag.status === "dropped");
	const activeBytes = activeTags.reduce((sum, tag) => sum + tag.byteSize, 0);
	const pendingOps = optional("Pending operations", () => readPendingOpsCount(deps.db, sessionId), 0);

	// Pipeline-side accounting describes the latest transformed prompt. On resume,
	// live Pi usage can arrive before that transform refreshes persisted buckets.
	// Render a composition only when every bucket fits the live input total.
	//
	// IMPORTANT: do NOT walk `ctx.sessionManager.getBranch()` here.
	// `getBranch()` returns the full leaf-to-root path INCLUDING
	// pre-compaction-marker entries that were never tagged because they
	// predate the marker. Tokenizing all of them and trying to subtract
	// "dropped tool tags" cannot work — there are no tags for the
	// pre-compaction tool calls at all, so the result over-counts by
	// the entire pre-marker tool history (we observed Tool Calls = 1.1M
	// on a 162K context — ~650% impossible). The pipeline-side walk
	// uses the post-compaction `event.messages` view, which is the
	// authoritative source for what the LLM receives.
	// Tool definition tokens: serialize each registered tool the way Pi sends
	// them to providers — name + description + JSON-stringified parameter
	// schema. This is a structural estimate (not the exact wire payload), but
	// matches the calibrated bucket within a reasonable margin.
	let tools: Array<{
		name?: string | undefined;
		description?: string | undefined;
		parameters?: unknown | undefined;
	}> = [];
	try {
		tools = pi.getAllTools?.() ?? [];
	} catch {
		// best effort
	}
	const prefix = estimatePiPrefixTokens({
		...(systemPrompt !== undefined ? { systemPrompt } : {}),
		tools,
		estimateTokens: text => tokenizer.countTokens(text),
	});
	const systemPromptTokens =
		prefix.systemPromptTokens > 0 ? prefix.systemPromptTokens : meta.systemPromptTokens;
	const toolDefinitionTokens = prefix.toolDefinitionTokens;
	const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
	const localM0Tokens = compartmentTokens + factTokens + memoryTokens + docsTokens + profileTokens;
	const conversationTokens = Math.max(0, meta.conversationTokens - localM0Tokens);
	const attributedTokens =
		systemPromptTokens +
		localM0Tokens +
		conversationTokens +
		meta.toolCallTokens +
		meta.recallTokens +
		toolDefinitionTokens;
	const storedAttributionMatchesModel =
		meta.tokenAttributionRevision !== null && meta.tokenAttributionModelKey === modelKey;
	const tokenBreakdownRefreshPending =
		storedAttributionMatchesModel &&
		inputTokens > 0 &&
		Number.isFinite(attributedTokens) &&
		attributedTokens > inputTokens;
	const tokenBreakdownAvailable =
		inputTokens > 0 &&
		Number.isFinite(attributedTokens) &&
		attributedTokens >= 0 &&
		attributedTokens <= inputTokens &&
		(storedAttributionMatchesModel || meta.tokenAttributionRevision === null);
	const toolCallTokens = tokenBreakdownAvailable ? meta.toolCallTokens : 0;
	const recallTokens = tokenBreakdownAvailable ? meta.recallTokens : 0;
	const unattributedTokens = tokenBreakdownAvailable ? Math.max(0, inputTokens - attributedTokens) : 0;
	if (tokenBreakdownRefreshPending) diagnostics.push("Token attribution refresh pending");
	const workMetrics = optional("Work metrics", () => getSessionWorkMetrics(deps.db, sessionId), { newWorkTokens: 0, totalInputTokens: inputTokens });
	let branchId = "main";
	try {
		branchId = deps.resolveBranchId?.(ctx)?.trim() || "main";
	} catch {
		diagnostics.push("Branch identity unavailable; using main");
	}
	const agentMemory = optional(
		"AgentMemory",
		() => readAgentMemoryStatus(deps.db, sessionId, branchId),
		{
			bridgeState: "degraded" as const,
			gates: { bridge: false, capture: false, inject: false, historianRetrieval: false, memoryTools: false },
			observed: {
				availability: "degraded" as const,
				lastSuccessAt: null,
				lastFailureAt: null,
				lastResult: null,
				lastOperation: null,
				lastError: null,
			},
			recallCount: 0,
			sourceKindCounts: {},
			presentationCounts: { pending: 0, claimed: 0, presented: 0 },
			recallPreviews: [],
			outbox: {
				pending: 0,
				leased: 0,
				failed: 0,
				oldestPendingAgeMs: null,
				nextRetryAt: null,
				latestError: null,
			},
		},
	);

	const threshold = optional("Execute threshold", () => resolveExecuteThresholdDetail(
		deps.executeThresholdPercentage ?? 65,
		modelKey,
		65,
		{
			tokensConfig: deps.executeThresholdTokens,
			contextLimit: contextLimit || undefined,
			sessionId,
		},
	), { percentage: 65, mode: "percentage" as const });
	const cacheTtl = meta.cacheTtl || "5m";
	let cacheTtlMs: number;
	try {
		cacheTtlMs = parseCacheTtl(cacheTtl);
	} catch {
		cacheTtlMs = 5 * 60 * 1000;
	}
	const neverExpires = cacheTtlMs === Number.POSITIVE_INFINITY;
	const elapsed = meta.lastResponseTime > 0 ? Date.now() - meta.lastResponseTime : 0;
	const cacheRemainingMs = neverExpires
		? Number.POSITIVE_INFINITY
		: meta.lastResponseTime > 0
			? Math.max(0, cacheTtlMs - elapsed)
			: cacheTtlMs;
	const cacheExpired = meta.lastResponseTime > 0 && cacheRemainingMs === 0;
	const historyBlockTokens = compartmentTokens + factTokens;
	const historyBudgetPercentage = deps.historyBudgetPercentage ?? 0.15;
	const compressionBudget =
		contextLimit > 0
			? Math.floor(
				contextLimit * (Math.min(threshold.percentage, 80) / 100) * historyBudgetPercentage,
			)
			: null;

	return {
		sessionId,
		projectIdentity: deps.projectIdentity,
		usagePercentage,
		inputTokens,
		tokenBreakdownAvailable,
		systemPromptTokens,
		compartmentCount: compartments.length,
		memoryCount: optional("Local memories", () => getMemoryCount(deps.db, deps.projectIdentity), 0),
		memoryBlockCount,
		sessionNoteCount: optional(
			"Session notes",
			() => getNotes(deps.db, { sessionId, type: "session", status: "active" }).length,
			0,
		),
		readySmartNoteCount: optional(
			"Smart notes",
			() =>
				getNotes(deps.db, {
					projectPath: deps.projectIdentity,
					type: "smart",
					status: "ready",
				}).length,
			0,
		),
		pendingOpsCount: pendingOps,
		historianRunning: meta.compartmentInProgress,
		historianFailureCount: historianFailure.failureCount,
		historianLastFailureAt: historianFailure.lastFailureAt,
		historianLastError: historianFailure.lastError,
		historianBackoffAt,
		historianLatestSuccess,
		cacheTtl,
		lastResponseTime: meta.lastResponseTime,
		cacheRemainingMs,
		cacheExpired,
		lastNudgeTokens: meta.lastNudgeTokens,
		lastNudgeBand: meta.lastNudgeBand ?? "",
		lastTransformError: meta.lastTransformError,
		isSubagent: meta.isSubagent,
		contextLimit,
		executeThreshold: threshold.percentage,
		executeThresholdMode: threshold.mode,
		executeThresholdClamped: threshold.clamped,
		executeThresholdConfigured: threshold.configuredValue,
		protectedTagCount: deps.protectedTags ?? 20,
		historyBlockTokens,
		compressionBudget,
		compressionUsage:
			compressionBudget && compressionBudget > 0
				? `${((historyBlockTokens / compressionBudget) * 100).toFixed(0)}%`
				: null,
		activeTags: activeTags.length,
		droppedTags: droppedTags.length,
		totalTags: tags.length,
		activeBytes,
		compartmentTokens,
		factTokens,
		memoryTokens,
		docsTokens,
		profileTokens,
		conversationTokens: tokenBreakdownAvailable ? conversationTokens : 0,
		toolCallTokens,
		recallTokens,
		unattributedTokens,
		tokenBreakdownRefreshPending,
		toolDefinitionTokens,
		newWorkTokens: workMetrics.newWorkTokens,
		totalInputTokens: workMetrics.totalInputTokens,
		upgradeNeededCount: optional(
			"Upgrade state",
			() => countCompartmentsNeedingUpgrade(deps.db, sessionId),
			0,
		),
		recompInFlight: isPiRecompInFlight(sessionId) || progressRunning,
		recompProgress,
		asyncJobsRunning,
		agentMemory,
		diagnostics,
	};
}
export function buildStatusSections(snapshot: StatusSnapshot): StatusSection[] {
	const cacheState = snapshot.cacheExpired
		? "expired"
		: snapshot.cacheRemainingMs === Number.POSITIVE_INFINITY
			? "never expires"
			: `${Math.round(snapshot.cacheRemainingMs / 1000)}s remaining`;
	const historianBackingOff =
		snapshot.historianBackoffAt !== null &&
		snapshot.historianBackoffAt !== undefined &&
		Date.now() - snapshot.historianBackoffAt < EMERGENCY_DRAIN_FAILURE_BACKOFF_MS;
	const historianState = snapshot.historianRunning
		? "running"
		: historianBackingOff
			? `backing off${snapshot.historianFailureCount > 0 ? ` (${snapshot.historianFailureCount})` : ""}`
			: snapshot.historianFailureCount > 0
				? `failed (${snapshot.historianFailureCount})`
				: snapshot.historianLatestSuccess
					? `succeeded ${relTime(snapshot.historianLatestSuccess.createdAt)}`
					: "idle";
	const historianSuccessDetail = snapshot.historianLatestSuccess
		? `${snapshot.historianLatestSuccess.runKind} · ${snapshot.historianLatestSuccess.compartmentsProduced} compartments · ${snapshot.historianLatestSuccess.factsEmitted} facts · ${snapshot.historianLatestSuccess.eventsEmitted} events · ${relTime(snapshot.historianLatestSuccess.createdAt)}`
		: null;
	const recompProgressDetail = snapshot.recompProgress ? formatRecompProgress(snapshot.recompProgress) : null;
	const upgradeAction = snapshot.upgradeNeededCount > 0 ? " · run /ctx-session-upgrade" : "";
	const diagnosticItems = [
		...snapshot.diagnostics.map(value => ({ label: "Status", value })),
		...(snapshot.lastTransformError ? [{ label: "Transform", value: snapshot.lastTransformError }] : []),
	];
	const sections: StatusSection[] = [
		{
			title: "Summary",
			items: [
				{ label: "Kernel context", value: `${fmt(snapshot.inputTokens)} / ${snapshot.contextLimit > 0 ? fmt(snapshot.contextLimit) : "?"} tokens (${snapshot.usagePercentage.toFixed(1)}%)` },
				{ label: "Projection / attribution", value: snapshot.tokenBreakdownRefreshPending ? "refresh pending" : snapshot.tokenBreakdownAvailable ? "available" : "unavailable" },
				{ label: "AgentMemory", value: `${snapshot.agentMemory.bridgeState} · ${snapshot.agentMemory.recallCount} active Recall${snapshot.agentMemory.recallCount === 1 ? "" : "s"}` },
				{ label: "Historian", value: historianState },
				{ label: "Recomp / upgrade", value: recompProgressDetail ?? (snapshot.recompInFlight ? "running (progress unavailable)" : snapshot.upgradeNeededCount > 0 ? `${snapshot.upgradeNeededCount} need upgrade · run /ctx-session-upgrade` : "idle") },
				...(snapshot.pendingOpsCount > 0 ? [{ label: "Maintenance", value: `${snapshot.pendingOpsCount} pending drops · run /ctx-flush` }] : []),
			],
		},
		{
			title: "Context",
			items: [
				{ label: "Session", value: snapshot.sessionId },
				{ label: "Project", value: snapshot.projectIdentity },
				...(snapshot.tokenBreakdownRefreshPending
					? [{ label: "Attribution", value: "refresh pending" }]
					: []),
				{
					label: "Kernel usage",
					value: `${fmt(snapshot.inputTokens)} / ${snapshot.contextLimit > 0 ? fmt(snapshot.contextLimit) : "?"} tokens (${snapshot.usagePercentage.toFixed(1)}%)`,
				},
				{ label: "Execute threshold", value: `${formatThresholdPercent(snapshot.executeThreshold)}%` },
			],
		},
		...(snapshot.tokenBreakdownAvailable
			? [
				{
					title: "Context attribution",
					items: [
						{ label: "System", value: `${fmt(snapshot.systemPromptTokens)} tokens` },
						{ label: "Docs", value: `${fmt(snapshot.docsTokens)} tokens` },
						{ label: "Compartments", value: `${fmt(snapshot.compartmentTokens)} tokens` },
						{ label: "Local memories", value: `${fmt(snapshot.memoryTokens)} tokens` },
						{ label: "User Profile", value: `${fmt(snapshot.profileTokens)} tokens` },
						{ label: "Conversation", value: `${fmt(snapshot.conversationTokens)} tokens` },
						{ label: "Recalls", value: `${fmt(snapshot.recallTokens)} tokens` },
						{ label: "Tool Calls", value: `${fmt(snapshot.toolCallTokens)} tokens` },
						{ label: "Tool Defs", value: `${fmt(snapshot.toolDefinitionTokens)} tokens` },
						{
							label: "Unattributed/Framing",
							value: `${fmt(snapshot.unattributedTokens)} tokens`,
						},
					],
				},
			]
			: []),
		{
			title: "Context state",
			items: [
				{ label: "Tags", value: `${snapshot.activeTags} active · ${snapshot.droppedTags} dropped` },
				{ label: "Pending drops", value: `${snapshot.pendingOpsCount}${snapshot.pendingOpsCount > 0 ? " · run /ctx-flush" : ""}` },
				{ label: "Cache", value: `${snapshot.cacheTtl} · ${cacheState}` },
				{
					label: "Notes",
					value: String(snapshot.sessionNoteCount + snapshot.readySmartNoteCount),
				},
			],
		},
		{
			title: "Memory",
			items: [
				{ label: "Local memories", value: `${snapshot.memoryCount} (${snapshot.memoryBlockCount} injected)` },
				{ label: "Bridge", value: snapshot.agentMemory.bridgeState },
				{
					label: "Gates",
					value: `capture ${snapshot.agentMemory.gates.capture ? "on" : "off"} · inject ${snapshot.agentMemory.gates.inject ? "on" : "off"} · historian retrieval ${snapshot.agentMemory.gates.historianRetrieval ? "on" : "off"} · memory tools ${snapshot.agentMemory.gates.memoryTools ? "on" : "off"}`,
				},
				...(snapshot.agentMemory.gates.bridge && snapshot.agentMemory.observed.availability !== "healthy"
					? [{ label: "Health", value: "run /agentmemory-health for a fresh probe" }]
					: []),
				{
					label: "Last observed",
					value: snapshot.agentMemory.observed.lastOperation
						? `${snapshot.agentMemory.observed.lastOperation} · ${snapshot.agentMemory.observed.lastResult === "failure" ? `failed ${snapshot.agentMemory.observed.lastFailureAt ? relTime(snapshot.agentMemory.observed.lastFailureAt) : "unknown"}` : snapshot.agentMemory.observed.lastResult === "success" ? `succeeded ${snapshot.agentMemory.observed.lastSuccessAt ? relTime(snapshot.agentMemory.observed.lastSuccessAt) : "unknown"}` : "unknown"}`
						: "no bridge operation observed",
				},
				{ label: "Active recalls", value: String(snapshot.agentMemory.recallCount) },
				{
					label: "Sources",
					value:
						Object.entries(snapshot.agentMemory.sourceKindCounts)
							.sort(([left], [right]) => left.localeCompare(right))
							.map(([kind, count]) => `${kind} ${count}`)
							.join(" · ") || "none",
				},
				{
					label: "Presentation",
					value: `presented ${snapshot.agentMemory.presentationCounts.presented} · pending ${snapshot.agentMemory.presentationCounts.pending} · claimed ${snapshot.agentMemory.presentationCounts.claimed}`,
				},
				{
					label: "Outbox",
					value: `pending ${snapshot.agentMemory.outbox.pending} · leased ${snapshot.agentMemory.outbox.leased} · failed ${snapshot.agentMemory.outbox.failed}${snapshot.agentMemory.outbox.oldestPendingAgeMs === null ? "" : ` · oldest pending ${Math.round(snapshot.agentMemory.outbox.oldestPendingAgeMs / 1000)}s`}${snapshot.agentMemory.outbox.nextRetryAt === null ? "" : snapshot.agentMemory.outbox.nextRetryAt <= Date.now() ? " · retry ready" : ` · retry in ${Math.round((snapshot.agentMemory.outbox.nextRetryAt - Date.now()) / 1000)}s`}`,
				},
				...(snapshot.agentMemory.outbox.latestError
					? [{ label: "Outbox error", value: snapshot.agentMemory.outbox.latestError }]
					: []),
				...(snapshot.agentMemory.observed.lastError
					? [{ label: "Bridge error", value: snapshot.agentMemory.observed.lastError }]
					: []),
				...snapshot.agentMemory.recallPreviews.map((preview, index) => ({
					label: `Recall ${index + 1} (${preview.sourceKinds.join(", ") || "unknown"}; ${preview.presentationState})`,
					value: preview.preview || "(empty)",
				})),
			],
		},
		{
			title: "Background Work",
			items: [
				{
					label: "Historian",
					value: historianState,
				},
				...(historianSuccessDetail ? [{ label: "Last successful run", value: historianSuccessDetail }] : []),
				{
					label: "Recomp / upgrade",
					value: recompProgressDetail ?? (snapshot.recompInFlight ? "running (progress unavailable)" : "idle"),
				},
				...(snapshot.upgradeNeededCount > 0
					? [{ label: "Upgrade needed", value: `${snapshot.upgradeNeededCount}${upgradeAction}` }]
					: []),
				...((snapshot.asyncJobsRunning ?? 0) > 0
					? [{ label: "Other async jobs", value: String(snapshot.asyncJobsRunning) }]
					: []),
			],
		},
		{
			title: "Diagnostics",
			items: diagnosticItems.length > 0 ? diagnosticItems : [{ label: "Status", value: "none" }],
		},
	];
	return normalizeStatusSections(sections);
}

function normalizeStatusSections(sections: StatusSection[]): StatusSection[] {
	const summary = sections.find((section) => section.title === "Summary");
	const contextItems = sections
		.filter((section) => section.title === "Context" || section.title.startsWith("Context "))
		.flatMap((section) => section.items);
	const memory = sections.find((section) => section.title === "Memory");
	const background = sections.find((section) => section.title === "Background Work");
	const diagnostics = sections.find((section) => section.title === "Diagnostics");
	return [
		...(summary ? [summary] : []),
		{ title: "Context", items: contextItems },
		memory ?? { title: "Memory", items: [{ label: "Status", value: "unavailable" }] },
		background ?? { title: "Background Work", items: [{ label: "Status", value: "idle" }] },
		diagnostics ?? { title: "Diagnostics", items: [{ label: "Status", value: "none" }] },
	];
}

export function renderStatusMarkdown(sections: StatusSection[]): string {
	return [
		"## Magic Status",
		...sections.flatMap((section) => [
			`### ${section.title}`,
			...section.items.map((item) => `- **${item.label}:** ${item.value}`),
		]),
	].join("\n\n");
}
function formatRecompProgress(progress: RecompProgress): string {
	const kind = progress.kind ?? "recomp";
	const progressText =
		progress.totalMessages > 0
			? `${Math.min(progress.processedMessages, progress.totalMessages)}/${progress.totalMessages} messages (${Math.round((Math.min(progress.processedMessages, progress.totalMessages) / progress.totalMessages) * 100)}%)`
			: progress.phase === "migration"
				? "migration"
				: "starting";
	const note = progress.note ?? progress.message;
	const compactNote = note?.replace(/\s+/g, " ").trim();
	return `${kind} · ${progress.phase} · ${progressText}${compactNote ? ` · ${compactNote}` : ""} · updated ${relTime(progress.updatedAt)}`;
}


function breakdownSegments(s: StatusSnapshot): Array<{
	label: string;
	tokens: number;
	color: string;
	detail?: string | undefined;
}> {
	if (!s.tokenBreakdownAvailable) return [];
	// Category labels/colors belong to this status surface. Facts are retired
	// (promoted to memories); Docs and User Profile are separate m[0] buckets.
	const segs: Array<{
		label: string;
		tokens: number;
		color: string;
		detail?: string | undefined;
	}> = [];
	if (s.systemPromptTokens > 0)
		segs.push({
			label: "System",
			tokens: s.systemPromptTokens,
			color: COLORS.system,
		});
	if (s.docsTokens > 0) segs.push({ label: "Docs", tokens: s.docsTokens, color: COLORS.docs });
	if (s.compartmentTokens > 0)
		segs.push({
			label: "Compartments",
			tokens: s.compartmentTokens,
			color: COLORS.compartments,
			detail: `(${s.compartmentCount})`,
		});
	if (s.memoryTokens > 0)
		segs.push({
			label: "Local Memories",
			tokens: s.memoryTokens,
			color: COLORS.memories,
			detail: `(${s.memoryBlockCount})`,
		});
	if (s.profileTokens > 0)
		segs.push({
			label: "User Profile",
			tokens: s.profileTokens,
			color: COLORS.profile,
		});
	if (s.conversationTokens > 0)
		segs.push({
			label: "Conversation",
			tokens: s.conversationTokens,
			color: COLORS.conversation,
		});
	if (s.recallTokens > 0)
		segs.push({ label: "Recalls", tokens: s.recallTokens, color: COLORS.recalls });
	if (s.unattributedTokens > 0)
		segs.push({
			label: "Unattributed/Framing",
			tokens: s.unattributedTokens,
			color: COLORS.unattributed,
		});
	if (s.toolCallTokens > 0)
		segs.push({
			label: "Tool Calls",
			tokens: s.toolCallTokens,
			color: COLORS.toolCalls,
		});
	if (s.toolDefinitionTokens > 0)
		segs.push({
			label: "Tool Defs",
			tokens: s.toolDefinitionTokens,
			color: COLORS.toolDefs,
		});
	return segs;
}

function renderBar(s: StatusSnapshot, innerWidth: number): string {
	// Fill the full inner content row. Clamp to a sensible minimum so
	// extremely narrow terminals still render a visible bar instead of
	// collapsing all segments to width 1.
	const barWidth = Math.max(20, innerWidth);
	const segs = breakdownSegments(s);
	if (segs.length === 0 || s.inputTokens <= 0) return "";
	const widths = segs.map((seg) =>
		Math.max(1, Math.round((seg.tokens / s.inputTokens) * barWidth)),
	);
	let sum = widths.reduce((a, b) => a + b, 0);
	while (sum > barWidth) {
		const maxIdx = widths.indexOf(Math.max(...widths));
		const current = widths[maxIdx];
		if (current !== undefined && current > 1) {
			widths[maxIdx] = current - 1;
			sum--;
		} else break;
	}
	while (sum < barWidth) {
		const maxIdx = widths.indexOf(Math.max(...widths));
		const current = widths[maxIdx] ?? 0;
		widths[maxIdx] = current + 1;
		sum++;
	}
	return segs.map((seg, i) => colorHex(seg.color, "█".repeat(widths[i] ?? 0))).join("");
}

function readSessionMetaRow(db: ContextDatabase, sessionId: string) {
	return db
		.prepare<
			[string],
			{
				memory_block_cache: string | null;
				memory_block_count: number | null;
				cached_m0_bytes: Buffer | Uint8Array | string | null;
				historian_failure_count: number | null;
				historian_last_failure_at: number | null;
				historian_last_error: string | null;
			}
		>(
			"SELECT memory_block_cache, memory_block_count, cached_m0_bytes, historian_failure_count, historian_last_failure_at, historian_last_error FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId);
}


function readPendingOpsCount(db: ContextDatabase, sessionId: string): number {
	const row = db
		.prepare<[string], { count: number }>("SELECT COUNT(*) as count FROM pending_ops WHERE session_id = ?")
		.get(sessionId);
	return row?.count ?? 0;
}

function fmt(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1_000_000) return `${trim1(n / 1_000_000)}M`;
	if (abs >= 1_000) return `${trim1(n / 1_000)}K`;
	return String(Math.round(n));
}

function trim1(n: number): string {
	const rounded = n.toFixed(1);
	return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}

function colorHex(hex: string, text: string): string {
	const clean = hex.replace("#", "");
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function relTime(ts: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return `${hours}h ago`;
}
