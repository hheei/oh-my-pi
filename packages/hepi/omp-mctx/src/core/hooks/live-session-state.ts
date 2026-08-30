import type { RecompProgress } from "./compartment-runner-types";

export type LiveModelBySession = Map<string, { providerID: string; modelID: string }>;
export type VariantBySession = Map<string, string | undefined>;
export type AgentBySession = Map<string, string>;

/**
 * Plugin-process-scoped shared state. Lives in `index.ts` and is threaded into
 * every component that needs to share signals with the Pi adapter.
 *
 * The `*Sessions` sets are the cache-busting signal channels added in
 * the Oracle 2026-04-26 review (replaces the old single `flushedSessions`).
 * `system-prompt-hash.ts` / `transform.ts` / `transform-postprocess-phase.ts`
 * for consumer drain points.
 *
 * Pi recomp publication signals the same sets used by the transform path.
 */
export interface LiveSessionState {
	liveModelBySession: LiveModelBySession;
	variantBySession: VariantBySession;
	agentBySession: AgentBySession;
	historyRefreshSessions: Set<string>;
	deferredHistoryRefreshSessions: Set<string>;
	systemPromptRefreshSessions: Set<string>;
	pendingMaterializationSessions: Set<string>;
	deferredMaterializationSessions: Set<string>;
	/**
	 * Cache of Pi session directory values.
	 *
	 * The session-to-project binding is stable for a session, so caching for
	 * the plugin process lifetime avoids repeated session metadata reads.
	 *
	 * Populated on first successful resolution; cleared on `session.deleted`.
	 */
	sessionDirectoryBySession: Map<string, string>;
	/**
	 * Live recomp / session-upgrade progress, keyed by sessionId. Written by the
	 * RPC recomp/upgrade handlers (via the runner's `onRecompProgress` callback
	 * plus their own migration/terminal updates) and read by `buildSidebarSnapshot`
	 * so the TUI sidebar + /ctx-status can show a live progress bar. In-memory
	 * only — a process restart interrupts the recomp anyway.
	 */
	recompProgressBySession: Map<string, RecompProgress>;
	/**
	 * Sessions that are Magic Context's OWN hidden children (historian,
	 * dreamer, sidekick, memory-migration). Detected at `session.created` by
	 * the `magic-context-` title prefix. These sessions are fully exempt from
	 * the message transform AND system-prompt injection — they have their own
	 * fixed agent identity/prompt, never use ctx_reduce/nudges/compartments,
	 * and getting the MC guidance block bolted on is wasted spend plus a
	 * contradictory second identity frame. In-memory only: these children are
	 * ephemeral (a process restart abandons any in-flight run), so the set
	 * never needs to survive a restart.
	 */
	internalChildSessions: Set<string>;
}

export function createLiveSessionState(): LiveSessionState {
	return {
		liveModelBySession: new Map<string, { providerID: string; modelID: string }>(),
		variantBySession: new Map<string, string | undefined>(),
		agentBySession: new Map<string, string>(),
		historyRefreshSessions: new Set<string>(),
		deferredHistoryRefreshSessions: new Set<string>(),
		systemPromptRefreshSessions: new Set<string>(),
		pendingMaterializationSessions: new Set<string>(),
		deferredMaterializationSessions: new Set<string>(),
		sessionDirectoryBySession: new Map<string, string>(),
		recompProgressBySession: new Map<string, RecompProgress>(),
		internalChildSessions: new Set<string>(),
	};
}
