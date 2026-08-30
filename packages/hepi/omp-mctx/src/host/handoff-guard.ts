export const HANDOFF_CONTEXT_TYPE = "magic-context:handoff";

export function branchHasHandoffContext(_ctx: {
	sessionManager?: { getEntries?: () => unknown[] };
}): boolean {
	return false;
}

export function applyHandoffAuthorityGuard(systemPrompt: string, hasHandoffContext: boolean): string {
	if (!hasHandoffContext) return systemPrompt;
	return systemPrompt;
}
