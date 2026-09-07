/**
 * Pi-side tool registration.
 *
 * Registers Window tools (`ctx_search`, `ctx_note`, `ctx_expand`, and
 * `ctx_reduce` against the live Pi extension API. The shared guidance block
 * in `system-prompt.ts` advertises these to the LLM only when each is
 * available, so a registration gap surfaces as "tool not found" errors when
 * the agent tries to follow the guidance.
 *
 * `ctx_reduce` is part of the primary session-scoped surface. It is omitted
 * only for `--no-session` child processes where session-scoped tools would
 * resolve to the hidden ephemeral child session.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getToolTui, registerToolTuiTrace, type ToolTui } from "#host/pi-ext-shim";
import type { ContextDatabase } from "#core/features/storage";
import { createCtxExpandTool } from "./ctx-expand";
import { createCtxNoteTool } from "./ctx-note";
import { createCtxReduceTool } from "./ctx-reduce";
import { createCtxSearchTool } from "./ctx-search";
import { createMemorySearchTool, type MemorySearchToolDeps } from "../agentmemory/memory-search";
import { createMemorySaveTool } from "../agentmemory/inject-save";
import type { AgentMemoryClientPort, RememberInput } from "../agentmemory/client";

export interface RegisterToolsOptions {
	db: ContextDatabase;
	ensureProjectRegistered?: ((directory: string, db: ContextDatabase) => Promise<void>) | undefined;
	memoryEnabled?: boolean | undefined;
	embeddingEnabled?: boolean | undefined;
	gitCommitsEnabled?: boolean | undefined;
	/** Resolve the current directory's project identity using the user-level home-project setting. */
	resolveProjectIdentity?: ((ctx: { cwd: string }) => string | undefined) | undefined;
	/** Number of recent tags that ctx_reduce should treat as protected
	 *  (deferred drops instead of immediate). Should match `magic_context.protected_tags`. */
	protectedTags?: number | undefined;
	/** Resolve protected-tag config from the current cwd at tool-call time. */
	resolveProtectedTags?: ((ctx: { cwd: string }) => number | undefined) | undefined;
	/** When true, ctx_note accepts smart notes (surface_condition) because
	 *  the dreamer is configured to evaluate them. When false, smart-note
	 *  writes are rejected to avoid stuck-pending state. */
	dreamerEnabled?: boolean | undefined;
	/** Resolve smart-note enablement from the current cwd at tool-call time. */
	resolveDreamerEnabled?: ((ctx: { cwd: string }) => boolean | undefined) | undefined;
	/** Unified current-Window plus agentmemory search, owned by the mctx bridge. */
	memorySearchTool?: MemorySearchToolDeps | undefined;
	/** Explicit durable save surface owned by the mctx agentmemory bridge. */
	memorySaveTool?:
		| {
				client: AgentMemoryClientPort;
				project: string | ((ctx: { cwd?: string }) => string);
				agentId?: string | ((ctx: { cwd?: string }) => string | undefined);
				queue?: (input: RememberInput) => Promise<{ candidateHash: string } | void>;
				drain?: (candidateHash?: string) => Promise<"saved" | "queued">;
		  }
		| undefined;
	/** When false, omit ctx_search from the registered agent surface. */
	searchToolEnabled?: boolean | undefined;
	/** When false, omit ctx_note; callers must also disable note-nudge injection. */
	noteToolEnabled?: boolean | undefined;
	/** When true, omit session-scoped tools (ctx_note, ctx_expand) from the
	 *  registered surface. Set by `--no-session` children (sidekick, dreamer):
	 *  those tools resolve `ctx.sessionManager.getSessionId()` to the EPHEMERAL
	 *  child session, so ctx_note would write notes orphaned under the hidden
	 *  child id and ctx_expand would expand the child's empty transcript. */
	sessionScopedToolsDisabled?: boolean | undefined;
	/** In compaction-off mode, omit ctx_reduce and keep the other Pi tools available. */
	compactionOff?: boolean | undefined;
}

function toolSummary(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}
	const value = args as Record<string, unknown>;
	if (typeof value.query === "string" && value.query.trim() !== "") {
		return value.query.trim();
	}
	if (typeof value.drop === "string" && value.drop.trim() !== "") {
		return value.drop.trim();
	}
	if (typeof value.message === "number") return `#${value.message}`;
	if (typeof value.start === "number" && typeof value.end === "number") {
		return `${value.start}-${value.end}`;
	}
	const action = typeof value.action === "string" ? value.action.trim() : "";
	if (action === "") return undefined;
	const ids = Array.isArray(value.ids)
		? value.ids.filter((id): id is number => typeof id === "number").join(",")
		: typeof value.note_id === "number"
			? String(value.note_id)
			: "";
	return ids === "" ? action : `${action} ${ids}`;
}

function frameTool<T>(tui: ToolTui, tool: T): T {
	return tui.frame(tool as never, {
		summary: (args: unknown) => toolSummary(args),
	}) as T;
}

export function registerMagicContextTools(pi: ExtensionAPI, opts: RegisterToolsOptions): void {
	const tui = getToolTui(pi);
	if (typeof pi.on === "function") registerToolTuiTrace(pi);
	const resolveProjectIdentity = opts.resolveProjectIdentity
		? (directory: string) => opts.resolveProjectIdentity?.({ cwd: directory })
		: undefined;

	if (opts.searchToolEnabled !== false) {
		pi.registerTool(
			frameTool(
				tui,
				createCtxSearchTool({
					db: opts.db,
					ensureProjectRegistered: opts.ensureProjectRegistered,
					memoryEnabled: opts.memoryEnabled,
					embeddingEnabled: opts.embeddingEnabled,
					gitCommitsEnabled: opts.gitCommitsEnabled,
					resolveProjectIdentity,
				}),
			),
		);
	}

	if (opts.memorySearchTool) {
		pi.registerTool(frameTool(tui, createMemorySearchTool(opts.memorySearchTool)));
	}
	if (opts.memorySaveTool) {
		pi.registerTool(frameTool(tui, createMemorySaveTool(opts.memorySaveTool)));
	}

	// ctx_note and ctx_expand are session-scoped: they resolve the CURRENT
	// session id at call time. For `--no-session` children that id is the hidden
	// ephemeral child session, so a note would be orphaned and an expand would
	// target the child's empty transcript. Omit them for those children; ctx_search
	// stays available independently of durable-memory retirement.
	if (!opts.sessionScopedToolsDisabled && opts.noteToolEnabled !== false) {
		pi.registerTool(
			frameTool(
				tui,
				createCtxNoteTool({
					db: opts.db,
					dreamerEnabled: opts.dreamerEnabled ?? false,
					resolveDreamerEnabled: opts.resolveDreamerEnabled,
					resolveProjectIdentity,
				}),
			),
		);
	}

	if (!opts.sessionScopedToolsDisabled) {
		pi.registerTool(frameTool(tui, createCtxExpandTool({ db: opts.db })));
	}

	// ctx_reduce is session-scoped just like ctx_note/ctx_expand: it resolves the
	// CURRENT session id at call time. Omit it for `--no-session` children where
	// that id points at a hidden ephemeral child session.
	if (!opts.sessionScopedToolsDisabled && !opts.compactionOff) {
		pi.registerTool(
			frameTool(
				tui,
				createCtxReduceTool({
					db: opts.db,
					protectedTags: opts.protectedTags ?? 20,
					resolveProtectedTags: opts.resolveProtectedTags,
				}),
			),
		);
	}
}
