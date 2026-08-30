import { BoundedSessionMap } from "../shared/bounded-session-map";

export interface ToolAvailabilityVerdict {
	callable: boolean;
	frozen: boolean;
}

export type CtxReduceAvailabilityVerdict = ToolAvailabilityVerdict;

const CTX_REDUCE_TOOL = "ctx_reduce";
let ctxReduceRegisteredGlobally = true;
const availabilityBySession = new BoundedSessionMap<boolean>(1000);

export function setCtxReduceRegisteredGlobally(registered: boolean): void {
	ctxReduceRegisteredGlobally = registered;
}

export function resetCtxReduceRegisteredGloballyForTest(): void {
	ctxReduceRegisteredGlobally = true;
}

function verdictFromToolsMap(tools: unknown, toolName: string): boolean | null {
	if (tools === null || typeof tools !== "object" || Array.isArray(tools)) return null;
	const map = tools as Record<string, unknown>;
	if (map[toolName] === true) return true;
	if (map[toolName] === false) return false;
	return map["*"] === false ? false : null;
}

export function resolveToolAvailabilityFromMessages(
	sessionId: string,
	toolName: string,
	messages: ReadonlyArray<{ info?: { role?: string; tools?: unknown } }>,
): ToolAvailabilityVerdict {
	if (toolName === CTX_REDUCE_TOOL && !ctxReduceRegisteredGlobally) {
		return { callable: false, frozen: true };
	}
	const key = `${toolName}\u0000${sessionId}`;
	const cached = availabilityBySession.get(key);
	if (cached !== undefined) return { callable: cached, frozen: true };
	for (const message of messages) {
		if (message.info?.role !== "user") continue;
		const callable = verdictFromToolsMap(message.info.tools, toolName) ?? true;
		availabilityBySession.set(key, callable);
		return { callable, frozen: true };
	}
	return { callable: true, frozen: false };
}

export function resolveToolAvailability(
	sessionId: string,
	toolName: string,
): ToolAvailabilityVerdict {
	if (toolName === CTX_REDUCE_TOOL && !ctxReduceRegisteredGlobally) {
		return { callable: false, frozen: true };
	}
	const cached = availabilityBySession.get(`${toolName}\u0000${sessionId}`);
	return cached === undefined
		? { callable: true, frozen: false }
		: { callable: cached, frozen: true };
}

export function clearToolAvailability(sessionId: string, toolName: string): void {
	availabilityBySession.delete(`${toolName}\u0000${sessionId}`);
}

export function resolveCtxReduceAvailabilityFromMessages(
	sessionId: string,
	messages: ReadonlyArray<{ info?: { role?: string; tools?: unknown } }>,
): CtxReduceAvailabilityVerdict {
	return resolveToolAvailabilityFromMessages(sessionId, CTX_REDUCE_TOOL, messages);
}

export function resolveCtxReduceAvailability(sessionId: string): CtxReduceAvailabilityVerdict {
	return resolveToolAvailability(sessionId, CTX_REDUCE_TOOL);
}

export function clearCtxReduceAvailability(sessionId: string): void {
	clearToolAvailability(sessionId, CTX_REDUCE_TOOL);
}
