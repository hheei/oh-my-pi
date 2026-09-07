import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import type { AgentMemoryClientPort } from "./client";
import type { AgentMemoryBridgeSettings } from "./config";
import { createAgentMemoryProjectResolver } from "./project";
import { AgentMemorySessionManager, type AgentMemorySessionContext, resolveOmpSessionId } from "./session";
import type { Database } from "../core/shared/sqlite";
import { linkAgentMemoryObservation } from "./outbox";
import { reconcileTurnTaintHostEntry, resolvePendingTurnId } from "./inject-save";

const MAX_CAPTURE_TEXT = 8_000;

const EXCLUDED_TOOLS = new Set([
	"ctx_reduce",
	"ctx_expand",
	"ctx_note",
	"ctx_memory",
	"ctx_search",
	"memory_search",
	"memory_save",
	"memory_recall",
	"memory_smart_search",
]);

function truncate(value: string): string {
	return value.length > MAX_CAPTURE_TEXT ? `${value.slice(0, MAX_CAPTURE_TEXT)}…` : value;
}

/** Remove common credential forms before a value enters an observation. */
export function redactCaptureText(value: string, secrets: readonly string[] = []): string {
	let result = value;
	for (const secret of secrets) {
		if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
	}
	result = result.replace(/(\b(?:authorization|proxy-authorization)\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
	result = result.replace(
		/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|credential)\s*[=:]\s*)([^\s,;]+)/gi,
		"$1[REDACTED]",
	);
	result = result.replace(/\b(?:sk|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
	return truncate(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Recursively redact text while preserving a JSON-shaped observation payload. */
export function redactCaptureValue(value: unknown, secrets: readonly string[] = []): unknown {
	if (typeof value === "string") return redactCaptureText(value, secrets);
	if (Array.isArray(value)) return value.map(entry => redactCaptureValue(entry, secrets));
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (/authorization|password|passwd|secret|token|api[_-]?key|credential/i.test(key)) {
			result[key] = "[REDACTED]";
		} else {
			result[key] = redactCaptureValue(entry, secrets);
		}
	}
	return result;
}

export function isExcludedMemoryTool(toolName: string | undefined): boolean {
	return toolName !== undefined && EXCLUDED_TOOLS.has(toolName.trim().toLowerCase());
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map(part => {
			if (typeof part === "string") return part;
			if (isRecord(part) && typeof part.text === "string") return part.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function branchEntryIdForPrompt(
	ctx: {
		sessionManager?: { getBranch?: () => readonly unknown[] };
	},
	prompt?: string,
): string | undefined {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as Record<string, unknown>;
		const message = (entry.message ?? entry) as Record<string, unknown>;
		if (
			message.role === "user" &&
			typeof entry.id === "string" &&
			entry.id.trim() &&
			(prompt === undefined || contentText(message.content).trim() === prompt.trim())
		)
			return entry.id.trim();
	}
	return undefined;
}

function branchEntryIdForTool(
	ctx: { sessionManager?: { getBranch?: () => readonly unknown[] } },
	toolCallId: string | undefined,
): string | undefined {
	if (!toolCallId) return undefined;
	for (const item of ctx.sessionManager?.getBranch?.() ?? []) {
		const entry = item as Record<string, unknown>;
		const message = (entry.message ?? entry) as Record<string, unknown>;
		if (message.role === "toolResult" && message.toolCallId === toolCallId && typeof entry.id === "string")
			return entry.id;
	}
	return undefined;
}

function branchEntryIdForAssistant(ctx: {
	sessionManager?: { getBranch?: () => readonly unknown[] };
}): string | undefined {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as Record<string, unknown>;
		const message = (entry.message ?? entry) as Record<string, unknown>;
		if (message.role === "assistant" && typeof entry.id === "string" && entry.id.trim()) return entry.id.trim();
	}
	return undefined;
}

function observationSourceContent(hookType: string, data: Record<string, unknown>): string {
	if (hookType === "prompt_submit" && typeof data.prompt === "string") return data.prompt;
	if (hookType.startsWith("post_tool_") && typeof data.tool_output === "string") return data.tool_output;
	if (hookType === "assistant_end" && typeof data.response === "string") return data.response;
	return JSON.stringify(data);
}

function assistantText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as unknown as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		const text = contentText(message.content);
		if (text.trim()) return text;
	}
	return "";
}

export interface AgentMemoryCaptureHandle {
	sessions: AgentMemorySessionManager;
	/** Host hook identity -> backend observation id, for provenance reconciliation. */
	readonly observationIds: ReadonlyMap<string, string>;
	shutdown: () => Promise<void>;
}

export type AgentMemoryCaptureRegistration = AgentMemoryCaptureHandle;

export interface AgentMemoryCaptureOptions {
	/** A function permits `/reload`-style runtime snapshots without rebuilding handlers. */
	settings: AgentMemoryBridgeSettings | (() => AgentMemoryBridgeSettings);
	sessions?: AgentMemorySessionManager;
	client?: AgentMemoryClientPort;
	logger?: ((message: string, data?: unknown) => void) | undefined;
	onFailure?: ((operation: string, error: unknown) => void) | undefined;
	db?: Database;
}

/**
 * Register best-effort lifecycle capture. Every observation is detached from
 * the event handler so a backend timeout or malformed response cannot alter
 * tool, transform, or compaction behavior.
 */
export function registerAgentMemoryCapture(
	pi: ExtensionAPI,
	options: AgentMemoryCaptureOptions,
): AgentMemoryCaptureHandle {
	const logger = options.logger ?? (() => {});
	const getSettings = (): AgentMemoryBridgeSettings =>
		typeof options.settings === "function" ? options.settings() : options.settings;
	const settings = getSettings();
	const onFailure =
		options.onFailure ??
		((operation: string, error: unknown) => logger("agentmemory capture failed", { operation, error }));
	const manager =
		options.sessions ??
		(options.client
			? new AgentMemorySessionManager({
					client: options.client,
					resolveIdentity: createAgentMemoryProjectResolver(settings),
					enabled: () => {
						const current = getSettings();
						return current.enabled && current.capture;
					},
					onFailure,
				})
			: (() => {
					throw new Error("agentmemory capture requires a session manager or client");
				})());
	const contextFor = (ctx: { cwd: string; sessionManager?: unknown }): AgentMemorySessionContext =>
		ctx as AgentMemorySessionContext;
	const observationIds = new Map<string, string>();
	const pendingObservations = new Map<
		string,
		{
			context: AgentMemorySessionContext;
			hookType: string;
			data: Record<string, unknown>;
			observationId?: string;
			toolCallId?: string;
			prompt?: string;
			turnId?: string;
		}
	>();
	const pendingKey = (context: AgentMemorySessionContext, hookType: string, identity?: string): string =>
		`${resolveOmpSessionId(context)}:${hookType}:${identity ?? "unidentified"}`;
	const reconcilePending = (context: AgentMemorySessionContext): void => {
		for (const [key, pending] of pendingObservations) {
			if (resolveOmpSessionId(pending.context) !== resolveOmpSessionId(context) || !pending.observationId) continue;
			const hostEntryId = pending.toolCallId
				? branchEntryIdForTool(context, pending.toolCallId)
				: pending.hookType === "assistant_end"
					? branchEntryIdForAssistant(context)
					: branchEntryIdForPrompt(context, pending.prompt);
			if (!hostEntryId || !options.db) continue;
			const binding = manager.getBinding(resolveOmpSessionId(context));
			if (!binding) continue;
			linkAgentMemoryObservation(options.db, {
				sourceId: hostEntryId,
				sessionId: binding.agentmemorySessionId,
				project: binding.project,
				sourceKind: pending.hookType,
				content: observationSourceContent(pending.hookType, pending.data),
				observationId: pending.observationId,
			});
			observationIds.set(hostEntryId, pending.observationId);
			pendingObservations.delete(key);
			if (pending.hookType === "prompt_submit" && pending.turnId && options.db)
				reconcileTurnTaintHostEntry(options.db, pending.turnId, hostEntryId);
		}
	};

	const ensureStarted = (context: AgentMemorySessionContext): void => {
		void manager.startForContext(context).catch((error: unknown) => {
			logger("agentmemory session start failed", error);
		});
	};

	const observe = (context: AgentMemorySessionContext, hookType: string, data: Record<string, unknown>): void => {
		const current = getSettings();
		if (!current.enabled || !current.capture) return;
		const secretValues = current.secret ? [current.secret] : [];
		const turnId = typeof data.prompt === "string" ? resolvePendingTurnId(context, data.prompt) : undefined;
		void (async () => {
			try {
				await manager.startForContext(context);
				const sanitizedData = redactCaptureValue(data, secretValues) as Record<string, unknown>;
				const observed = await manager.observeForContext(context, {
					hookType,
					cwd: context.cwd,
					data: sanitizedData,
				});
				const observationId = observed?.observationId;
				const hostEntryId = typeof data.hostEntryId === "string" ? data.hostEntryId : undefined;
				if (observationId && hostEntryId) observationIds.set(hostEntryId, observationId);
				if (observationId && !hostEntryId) {
					const toolCallId = typeof data.tool_call_id === "string" ? data.tool_call_id : undefined;
					pendingObservations.set(pendingKey(context, hookType, toolCallId ?? turnId), {
						context,
						hookType,
						data: sanitizedData,
						observationId,
						...(toolCallId ? { toolCallId } : {}),
						...(hookType === "prompt_submit"
							? { prompt: typeof data.prompt === "string" ? data.prompt : undefined }
							: {}),
						...(turnId ? { turnId } : {}),
					});
				}
				if (observationId && hostEntryId && options.db) {
					const binding = manager.getBinding(resolveOmpSessionId(context));
					if (binding)
						linkAgentMemoryObservation(options.db, {
							sourceId: hostEntryId,
							sessionId: binding.agentmemorySessionId,
							project: binding.project,
							sourceKind: hookType,
							content: observationSourceContent(hookType, sanitizedData),
							observationId,
						});
				}
			} catch (error) {
				(options.onFailure ?? logger)("capture", {
					hookType,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	};

	pi.on("session_start", (_event, ctx) => ensureStarted(contextFor(ctx)));
	pi.on("session_switch", (_event, ctx) => ensureStarted(contextFor(ctx)));
	pi.on("before_agent_start", (event, ctx) => {
		const prompt = event.prompt?.trim();
		if (prompt)
			observe(contextFor(ctx), "prompt_submit", {
				prompt,
			});
	});
	pi.on("agent_end", (_event, ctx) => reconcilePending(contextFor(ctx)));
	pi.on("turn_end", (_event, ctx) => reconcilePending(contextFor(ctx)));
	pi.on("tool_result", (event, ctx) => {
		if (isExcludedMemoryTool(event.toolName)) return;
		const current = getSettings();
		if (!current.enabled || !current.capture) return;
		const secretValues = current.secret ? [current.secret] : [];
		const output = contentText(event.content);
		const input = redactCaptureValue(event.input, secretValues);
		observe(contextFor(ctx), event.isError ? "post_tool_failure" : "post_tool_use", {
			tool_name: event.toolName,
			tool_call_id: event.toolCallId,
			tool_input: input,
			tool_output: redactCaptureText(output, secretValues),
			...(event.isError ? { tool_error: true } : {}),
			...(branchEntryIdForTool(ctx, event.toolCallId)
				? { hostEntryId: branchEntryIdForTool(ctx, event.toolCallId) }
				: {}),
		});
	});
	pi.on("agent_end", (event, ctx) => {
		if (event.willContinue) return;
		const output = assistantText(event.messages);
		if (output) observe(contextFor(ctx), "assistant_end", { assistant_output: output });
	});
	pi.on("session_shutdown", async () => {
		try {
			await manager.endAll();
		} catch (error) {
			logger("agentmemory session shutdown failed", error);
		}
	});

	return { sessions: manager, observationIds, shutdown: () => manager.endAll() };
}

/** Compatibility name for callers migrating from the standalone bridge. */
export const registerCapture = registerAgentMemoryCapture;
