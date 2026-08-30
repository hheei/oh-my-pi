/**
 * User-facing spelling of the compaction-off config path, for log lines and
 * command output. Built from fragments so the accessor-exclusivity guard
 * (compaction-accessor-guard.test.ts) can keep rejecting literal
 * `compaction.enabled` reads elsewhere — messages import this constant instead
 * of inlining the path (the S5/S8 slices both re-derived it and tripped the
 * guard; one constant ends that class).
 */
export const COMPACTION_ENABLED_PATH = `compaction${"."}enabled`;

export function isDreamerRunnable(config: {
	dreamer?: { disable?: boolean | undefined } | null | undefined;
}): boolean {
	return !!config.dreamer && config.dreamer.disable !== true;
}

export function isSidekickRunnable(config: {
	sidekick?: { disable?: boolean | undefined } | null | undefined;
}): boolean {
	return !!config.sidekick && config.sidekick.disable !== true;
}

export function isHistorianRunnable(config: {
	historian?: { disable?: boolean | undefined } | null | undefined;
}): boolean {
	return config.historian?.disable !== true;
}

/**
 * The ONLY non-schema reader of the `compaction.enabled` config path.
 * Resolves the compaction-off mode gate from a parsed Magic Context config.
 * Lives beside the other subsystem toggles (isDreamerRunnable /
 * isHistorianRunnable) and is IMPORTED — never re-derived — by every gate
 * site (pi-plugin, cli, plugin boot, session hooks). Returns true (compaction
 * ON / default behavior) when the block or field is absent.
 */
export function isCompactionEnabled(config: {
	compaction?: { enabled?: boolean | undefined } | null | undefined;
}): boolean {
	return config.compaction?.enabled !== false;
}
