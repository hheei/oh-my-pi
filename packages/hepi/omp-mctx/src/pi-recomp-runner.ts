import { type RawMessageProvider, setRawMessageProvider } from "#core/hooks/read-session-chunk";
import { sessionLog } from "#core/shared/logger";

/**
 * In-flight detached recomp / upgrade runs, keyed by session, so the
 * `session_shutdown` handler can await them before Pi exits — mirrors
 * `inFlightHistorian` in context-handler.ts.
 *
 * Why detached: Pi's command handler IS the REPL turn (single process). Awaiting
 * a multi-pass recomp inline froze ALL input — new prompts and even /ctx-status —
 * until it finished (dogfood 2026-06-01: a 1105-message upgrade locked the REPL
 * across several ~4-min historian passes). Recomp/upgrade runs as
 * `void runManagedRecomp(...)` in its separate server process; Pi must do the
 * equivalent fire-and-forget so the REPL stays responsive while the historian
 * passes run in the background — the same pattern as `spawnPiHistorianRun`.
 */
const inFlightRecomp = new Map<string, Promise<unknown>>();

/** True when a detached recomp/upgrade is already running for this session. */
export function isPiRecompInFlight(sessionId: string): boolean {
 return inFlightRecomp.has(sessionId);
}

/**
 * Await all in-flight recomp/upgrade runs. Called from `session_shutdown`
 * (bounded by a timeout there) so a background recomp can finish publishing
 * before Pi tears the session down.
 */
export async function awaitInFlightRecomps(): Promise<void> {
 if (inFlightRecomp.size === 0) return;
 await Promise.allSettled(Array.from(inFlightRecomp.values()));
}

/**
 * Run a recomp/upgrade body detached from the command handler.
 *
 * Registers the raw-message provider for the run's lifetime, tracks the
 * promise for shutdown drain, and cleans everything up on settle. The command
 * handler returns immediately after calling this, so the Pi REPL stays
 * responsive. `work()` owns all command-specific logic (the recomp call, the
 * published gate, marker staging, migration, and the status messages it sends)
 * and must not throw uncaught — failures are logged.
 *
 * The provider unregister is closure-guarded (setRawMessageProvider only deletes
 * if the slot still holds THIS provider), so a concurrent user turn that
 * re-registers its own provider for the same session is not clobbered on
 * cleanup.
 */
export function spawnPiRecompRun(args: {
	sessionId: string;
	provider: RawMessageProvider;
	work: () => Promise<void>;
}): void {
	const { sessionId, provider, work } = args;
	const unregister = setRawMessageProvider(sessionId, provider);
	// Defer work by one microtask so the in-flight map is populated before a
	// synchronously-resolving test/runtime body can reach its finally cleanup.
	const runPromise = Promise.resolve()
		.then(work)
		.catch(err => {
			sessionLog(
				sessionId,
				`pi recomp run failed (detached): ${err instanceof Error ? err.message : String(err)}`,
			);
		})
		.finally(() => {
			inFlightRecomp.delete(sessionId);
			unregister();
		});
	inFlightRecomp.set(sessionId, runPromise);
}
