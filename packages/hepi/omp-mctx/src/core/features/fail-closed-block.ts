/** Loud fail-closed blocking when persistent storage cannot open. */

export const FAIL_CLOSED_RECOVERY_GUIDANCE =
	"inspect ~/.omp/agent/extensions/omp-mctx/context.db and reload OMP after fixing storage access";

/** How often a blocked transform pass re-attempts storage open (1 = every pass). */
export const FAIL_CLOSED_REPROBE_EVERY_N = 5;

export type FailClosedReason = {
	kind: "storage_failure";
	cause: string;
};

export class FailClosedBlockingError extends Error {
	readonly code = "FAIL_CLOSED_BLOCKING";
	readonly reason: FailClosedReason;

	constructor(message: string, reason: FailClosedReason, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "FailClosedBlockingError";
		this.reason = reason;
	}
}

/**
 * Magic Context hidden-child agent ids (and stable prefixes). These sessions are
 * single-shot / bounded jobs that must keep running even when the primary
 * session is blocked — otherwise recovery work and background maintenance stall.
 */
function isMagicContextHiddenAgentName(agent: string): boolean {
	if (agent === "sidekick" || agent === "smart-note-compiler" || agent.startsWith("smart-note-")) {
		return true;
	}
	if (agent === "historian" || agent.startsWith("historian-")) return true;
	if (agent === "dreamer" || agent.startsWith("dreamer-")) return true;
	return false;
}

export function formatFailClosedBlockingMessage(reason: FailClosedReason): string {
	const cause = reason.cause.trim().length > 0 ? reason.cause.trim() : "unknown storage error";
	return [
		`Magic Context cannot operate: persistent storage failed (${cause}).`,
		"The plugin will not silently degrade to native compaction while enabled.",
		`Recovery: ${FAIL_CLOSED_RECOVERY_GUIDANCE}`,
	].join(" ");
}

export function createFailClosedBlockingError(
	reason: FailClosedReason,
	options?: { cause?: unknown },
): FailClosedBlockingError {
	return new FailClosedBlockingError(formatFailClosedBlockingMessage(reason), reason, options);
}

export function isFailClosedBlockingError(error: unknown): error is FailClosedBlockingError {
	return (
		error instanceof FailClosedBlockingError ||
		(typeof error === "object" &&
			error !== null &&
			(error as { name?: string }).name === "FailClosedBlockingError" &&
			(error as { code?: string }).code === "FAIL_CLOSED_BLOCKING")
	);
}

/**
 * Whether this transform/context pass should skip the loud block.
 * Magic Context hidden children and Pi subagent processes are.
 */
export function shouldBypassFailClosedBlock(input: {
	agent?: string | null | undefined;
	isInternalChildSession?: boolean | undefined;
	isPiSubagentEnv?: boolean | undefined;
}): boolean {
	if (input.isPiSubagentEnv === true) return true;
	if (input.isInternalChildSession === true) return true;
	const agent = typeof input.agent === "string" ? input.agent.trim() : "";
	if (agent.length === 0) return false;
	if (isMagicContextHiddenAgentName(agent)) return true;
	return false;
}

export function resolveAgentNameFromMessages(
	messages: ReadonlyArray<{ info?: unknown } | null | undefined>,
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const info = messages[i]?.info;
		if (!info || typeof info !== "object") continue;
		const agent = (info as { agent?: unknown }).agent;
		if (typeof agent === "string" && agent.length > 0) return agent;
	}
	return undefined;
}

export interface FailClosedController {
	arm(reason: FailClosedReason): void;
	clear(): void;
	isArmed(): boolean;
	getReason(): FailClosedReason | null;
	/**
	 * Enforce the gate for one transform/context pass.
	 * - No-op when unarmed, when blocking is disabled, or when the pass is exempt.
	 * - Periodically re-probes storage; clears and returns when reopen succeeds.
	 * - Otherwise throws {@link FailClosedBlockingError}.
	 */
	enforce(input: {
		blockingEnabled: boolean;
		exempt: boolean;
		tryReopen?: (() => boolean | Promise<boolean>) | undefined;
	}): void | Promise<void>;
}

/**
 * Process-local controller shared by the boot path (arms on deterministic
 * inoperability) and the per-turn transform (enforces / re-probes).
 */
export function createFailClosedController(options?: {
	reprobeEveryN?: number | undefined;
}): FailClosedController {
	const reprobeEveryN = Math.max(1, options?.reprobeEveryN ?? FAIL_CLOSED_REPROBE_EVERY_N);
	let reason: FailClosedReason | null = null;
	let blockedPassCount = 0;

	return {
		arm(next: FailClosedReason): void {
			reason = next;
			blockedPassCount = 0;
		},
		clear(): void {
			reason = null;
			blockedPassCount = 0;
		},
		isArmed(): boolean {
			return reason !== null;
		},
		getReason(): FailClosedReason | null {
			return reason;
		},
		async enforce(input): Promise<void> {
			if (!reason) return;
			if (!input.blockingEnabled) return;
			if (input.exempt) return;

			blockedPassCount += 1;
			const shouldReprobe =
				typeof input.tryReopen === "function" &&
				(blockedPassCount === 1 || blockedPassCount % reprobeEveryN === 0);
			if (shouldReprobe) {
				try {
					const healed = await input.tryReopen?.();
					if (healed) {
						reason = null;
						blockedPassCount = 0;
						return;
					}
				} catch {
					// Re-probe failed — keep blocking with the original reason.
				}
			}

			// Local capture: reason may be cleared by a concurrent heal path.
			const blockedReason = reason;
			if (!blockedReason) return;
			throw createFailClosedBlockingError(blockedReason);
		},
	};
}

/** Hook-init classification so boot can arm the gate for storage failures. */
export type HookInitFailure =
	| { type: "storage"; reason: FailClosedReason }
	| { type: "no_project" };

let lastHookInitFailure: HookInitFailure | null = null;

export function recordHookInitFailure(failure: HookInitFailure): void {
	lastHookInitFailure = failure;
}

export function clearHookInitFailure(): void {
	lastHookInitFailure = null;
}

export function getLastHookInitFailure(): HookInitFailure | null {
	return lastHookInitFailure;
}
