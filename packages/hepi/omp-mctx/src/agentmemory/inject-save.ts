import * as crypto from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type, type Static } from "@oh-my-pi/omptype/typebox";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { PREVIEW_LIMITS, shortenPath, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import {
	decodeAgentMemorySearchResults,
	type AgentMemoryClientPort,
	type RememberInput,
	type RememberResult,
} from "./client.ts";
import { Database, type Database as DatabaseType } from "../core/shared/sqlite";
import { ensureAgentMemoryOutboxSchema } from "./outbox";
import injectPrompt from "./inject-prompt.md" with { type: "text" };

function safeToolMessage(value: string): string {
	return truncateToWidth(replaceTabs(shortenPath(value)), PREVIEW_LIMITS.OUTPUT_EXPANDED * TRUNCATE_LENGTHS.LONG);
}

export type TurnTaint = { turnId: string; fingerprint: string; createdAt: number; hostEntryId?: string };

export interface TurnTaintStore {
	get(turnId: string): TurnTaint | undefined;
	put(value: TurnTaint): void;
	isHostEntryTainted?(hostEntryId: string): boolean;
}

export function markTurnTainted(store: TurnTaintStore, turnId: string, reason: string, hostEntryId?: string): void {
	if (!turnId.trim()) return;
	store.put({
		turnId,
		fingerprint: fingerprintRecall(reason),
		createdAt: Date.now(),
		...(hostEntryId ? { hostEntryId } : {}),
	});
}

export class SqliteTurnTaintStore implements TurnTaintStore {
	readonly #db: DatabaseType;
	readonly #sessionId: string;

	constructor(dbOrPath: DatabaseType | string, sessionId = "default") {
		this.#db = typeof dbOrPath === "string" ? new Database(dbOrPath) : dbOrPath;
		this.#sessionId = sessionId;
		ensureAgentMemoryOutboxSchema(this.#db);
	}

	get(turnId: string): TurnTaint | undefined {
		const row = this.#db
			.prepare(
				"SELECT turn_id, reason, created_at, host_entry_id FROM agentmemory_turn_taint WHERE session_id = ? AND turn_id = ?",
			)
			.get(this.#sessionId, turnId) as { turn_id?: string; reason?: string; created_at?: number } | undefined;
		if (!row?.turn_id || !row.reason || typeof row.created_at !== "number") return undefined;
		return {
			turnId: row.turn_id,
			fingerprint: row.reason,
			createdAt: row.created_at,
			...((row as { host_entry_id?: string }).host_entry_id
				? { hostEntryId: (row as { host_entry_id: string }).host_entry_id }
				: {}),
		};
	}

	isHostEntryTainted(hostEntryId: string): boolean {
		return Boolean(
			this.#db
				.prepare("SELECT 1 FROM agentmemory_turn_taint WHERE session_id = ? AND host_entry_id = ? LIMIT 1")
				.get(this.#sessionId, hostEntryId),
		);
	}

	put(value: TurnTaint): void {
		this.#db
			.prepare(
				"INSERT INTO agentmemory_turn_taint(session_id, turn_id, reason, host_entry_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, turn_id) DO UPDATE SET reason = excluded.reason, host_entry_id = excluded.host_entry_id, created_at = excluded.created_at",
			)
			.run(this.#sessionId, value.turnId, value.fingerprint, value.hostEntryId ?? null, value.createdAt);
	}
}

export function reconcileTurnTaintHostEntry(db: DatabaseType, turnId: string, hostEntryId: string): void {
	ensureAgentMemoryOutboxSchema(db);
	db.prepare(
		"UPDATE agentmemory_turn_taint SET host_entry_id = ? WHERE session_id = ? AND turn_id = ? AND host_entry_id IS NULL",
	).run(hostEntryId, "agentmemory", turnId);
}

/** Backward-compatible name for callers; storage is SQLite, never a JSON file. */
export const JsonTurnTaintStore = SqliteTurnTaintStore;

export function fingerprintRecall(content: string): string {
	return crypto.createHash("sha256").update(content.trim()).digest("hex");
}

export function isSubstantivePrompt(prompt: string): boolean {
	const text = prompt.trim();
	return text.length >= 8 && !/^\/(help|quit|exit|clear|reload|ctx-status)\b/i.test(text);
}

export type AgentMemoryRecall = { content: string; id?: string };

type BranchContext = {
	sessionManager?: { getSessionId?: () => string | undefined; getBranch?: () => readonly unknown[] };
};

export function resolveLatestUserEntryId(ctx: BranchContext): string | undefined {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as Record<string, unknown>;
		const message = (entry.message ?? entry) as Record<string, unknown>;
		if (message.role === "user" && typeof entry.id === "string" && entry.id.trim()) return entry.id.trim();
	}
	return undefined;
}

function branchFingerprint(ctx: BranchContext): string {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	const last = branch[branch.length - 1] as Record<string, unknown> | undefined;
	return typeof last?.id === "string" ? last.id : "";
}

export function resolvePendingTurnId(ctx: BranchContext, promptText: string): string {
	const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
	return `turn-${fingerprintRecall(`${sessionId}\n${branchFingerprint(ctx)}\n${promptText.trim()}`).slice(0, 24)}`;
}

export type AgentMemoryInjectOptions = {
	client: AgentMemoryClientPort;
	project: string;
	agentId?: string;
	store: TurnTaintStore;
	turnId: (event: { prompt: string }, ctx: BranchContext) => string;
	activeRemoteSessionId?: (ctx: {
		sessionManager?: { getSessionId?: () => string | undefined };
	}) => string | undefined;
	limit?: number;
	/** Scope is resolved at the event site so session switches cannot reuse boot identity. */
	scope?: (ctx: { cwd?: string }) => { project: string; agentId?: string };
};

export function formatRecall(recall: AgentMemoryRecall[]): string {
	return recall
		.map(item => `- ${item.content.trim()}`)
		.filter(line => line !== "-")
		.join("\n");
}

export function createAgentMemoryInjectHandler(options: AgentMemoryInjectOptions) {
	return async (event: { prompt: string }, ctx: BranchContext & { cwd?: string }) => {
		const resolvedScope = options.scope?.(ctx) ?? {
			project: options.project,
			...(options.agentId ? { agentId: options.agentId } : {}),
		};
		if (!isSubstantivePrompt(event.prompt) || !resolvedScope.project) return undefined;
		const suppliedTurnId = options.turnId(event, ctx);
		const turnId = suppliedTurnId || resolvePendingTurnId(ctx, event.prompt);
		try {
			const response = await options.client.search({
				query: event.prompt.trim(),
				project: resolvedScope.project,
				...(resolvedScope.agentId ? { agentId: resolvedScope.agentId } : {}),
				limit: options.limit ?? 4,
			});
			const entries = decodeAgentMemorySearchResults(response);
			const observationSessions = new Map<string, { project?: string; agentId?: string }>();
			if (
				entries.some(entry => entry.kind === "observation" && !entry.project && entry.sessionId) &&
				typeof options.client.listSessions === "function"
			) {
				for (const session of await options.client.listSessions()) {
					const id = session.id ?? session.sessionId;
					if (id) observationSessions.set(id, session);
				}
			}
			const recalled = await Promise.all(
				entries.map(async (entry): Promise<AgentMemoryRecall[]> => {
					const session = entry.sessionId ? observationSessions.get(entry.sessionId) : undefined;
					let value = { ...entry, ...session } as Record<string, unknown>;
					if (
						entry.kind !== "observation" &&
						(typeof value.project !== "string" ||
							(resolvedScope.agentId !== undefined &&
								typeof value.agentId !== "string" &&
								typeof value.agent_id !== "string")) &&
						typeof value.id === "string" &&
						options.client.getMemory
					) {
						try {
							const hydrated = await options.client.getMemory(value.id);
							if (hydrated) value = { ...value, ...hydrated };
						} catch {
							return [];
						}
					}
					const entryProject =
						typeof value.project === "string"
							? value.project.trim()
							: typeof value.projectName === "string"
								? value.projectName.trim()
								: "";
					const entryAgent =
						typeof value.agentId === "string"
							? value.agentId.trim()
							: typeof value.agent_id === "string"
								? value.agent_id.trim()
								: "";
					const entrySession =
						typeof value.sessionId === "string"
							? value.sessionId.trim()
							: typeof value.session_id === "string"
								? value.session_id.trim()
								: "";
					// Injection is fail-closed. Unscoped records are not model-visible;
					// the unified search path performs explicit hydration when possible.
					if (
						entryProject !== resolvedScope.project ||
						(resolvedScope.agentId !== undefined && entryAgent !== resolvedScope.agentId) ||
						(options.activeRemoteSessionId?.(ctx) !== undefined &&
							entrySession === options.activeRemoteSessionId?.(ctx))
					)
						return [];
					const content =
						typeof value.content === "string"
							? value.content.trim()
							: typeof value.text === "string"
								? value.text.trim()
								: "";
					return content ? [{ content, ...(typeof value.id === "string" ? { id: value.id } : {}) }] : [];
				}),
			);
			const recall = recalled.flat();
			const content = formatRecall(recall);
			if (!content) return undefined;
			const fingerprint = fingerprintRecall(content);
			if (options.store.get(turnId)?.fingerprint === fingerprint) return undefined;
			markTurnTainted(options.store, turnId, content);
			return {
				ephemeralMessage: {
					customType: "agentmemory-recall",
					content: prompt.render(injectPrompt, { recall: content }),
					display: false as const,
					attribution: "agent" as const,
				},
			};
		} catch {
			return undefined;
		}
	};
}

const SaveParams = Type.Object({
	content: Type.String({ description: "The durable fact to save." }),
	type: Type.Optional(
		Type.Union([
			Type.Literal("pattern"),
			Type.Literal("preference"),
			Type.Literal("architecture"),
			Type.Literal("bug"),
			Type.Literal("workflow"),
			Type.Literal("fact"),
		]),
	),
});
type SaveParams = Static<typeof SaveParams>;

export type MemorySaveResult = { status: "saved" | "queued" | "rejected"; id?: string; reason?: string };

export function validateRememberResponse(response: RememberResult): string {
	if (response.success !== true || !response.memory?.id)
		throw new Error("remember response did not confirm persistence");
	return response.memory.id;
}

export function createMemorySaveTool(options: {
	client: AgentMemoryClientPort;
	project: string | ((ctx: { cwd?: string }) => string);
	agentId?: string | ((ctx: { cwd?: string }) => string | undefined);
	queue?: (input: RememberInput) => Promise<{ candidateHash: string } | void>;
	drain?: (candidateHash?: string) => Promise<"saved" | "queued">;
}): ToolDefinition<typeof SaveParams> {
	return {
		name: "memory_save",
		label: "Memory Save",
		description: "Save an explicit fact to scoped durable memory.",
		parameters: SaveParams,
		async execute(_id, params: SaveParams, _signal, _onUpdate, ctx) {
			const content = params.content.trim();
			const configuredProject = typeof options.project === "function" ? options.project(ctx) : options.project;
			const project = configuredProject.trim();
			if (!content || !project)
				return {
					content: [{ type: "text", text: "rejected: content and project are required" }],
					details: { status: "rejected" } satisfies MemorySaveResult,
				};
			const agentId = typeof options.agentId === "function" ? options.agentId(ctx) : options.agentId;
			const input = {
				content,
				project,
				...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
				...(params.type?.trim() ? { type: params.type.trim() } : {}),
			};
			// When a durable outbox is available it is the canonical first write.
			// This keeps the user-visible save atomic with local publication and
			// lets the bounded drainer handle remote delivery/retry.
			if (options.queue) {
				try {
					const queued = await options.queue(input);
					const status =
						(await options.drain?.(typeof queued === "object" ? queued.candidateHash : undefined)) ?? "queued";
					return {
						content: [
							{
								type: "text",
								text:
									status === "saved"
										? "saved: durable delivery confirmed"
										: "queued: durable delivery pending",
							},
						],
						details: { status } satisfies MemorySaveResult,
					};
				} catch {
					return {
						content: [{ type: "text", text: "rejected: unable to queue durable delivery" }],
						details: { status: "rejected", reason: "queue failed" } satisfies MemorySaveResult,
					};
				}
			}
			try {
				const id = validateRememberResponse(await options.client.remember(input));
				return {
					content: [{ type: "text", text: `saved: ${id}` }],
					details: { status: "saved", id } satisfies MemorySaveResult,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `rejected: ${safeToolMessage(error instanceof Error ? error.message : String(error))}`,
						},
					],
					details: { status: "rejected", reason: "remember failed" } satisfies MemorySaveResult,
				};
			}
		},
	};
}

export function registerAgentMemoryHealthCommand(pi: ExtensionAPI, client: AgentMemoryClientPort): void {
	pi.registerCommand("agentmemory-health", {
		description: "Check the agentmemory service health",
		handler: async (_args, ctx) => {
			try {
				const health = await client.health();
				ctx.ui.notify(`agentmemory: ${safeToolMessage(health.status ?? health.health?.status ?? "ok")}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`agentmemory unavailable: ${safeToolMessage(error instanceof Error ? error.message : String(error))}`,
					"error",
				);
			}
		},
	});
}
