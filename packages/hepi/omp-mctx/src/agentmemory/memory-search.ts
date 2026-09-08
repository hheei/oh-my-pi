import * as crypto from "node:crypto";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type, type Static } from "@oh-my-pi/omptype/typebox";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { PREVIEW_LIMITS, shortenPath, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { decodeAgentMemorySearchResults, type AgentMemoryClientPort, type SearchResult } from "./client.ts";

export type MemorySearchScope = { project: string; agentId?: string; activeSessionId?: string };
export type MemorySearchRemoteCandidate = {
	id: string;
	content: string;
	project?: string;
	agentId?: string;
	sessionId?: string;
	score?: number;
	kind: "memory" | "observation" | "lesson";
};
export type MemorySearchLocalCandidate = { id: string; content: string; score?: number; kind?: string };
export type MemorySearchResult = {
	local: MemorySearchLocalCandidate[];
	remote: MemorySearchRemoteCandidate[];
	partial: string[];
};
export type MemorySearchOptions = {
	limit?: number;
	contentBudget?: number;
	perSourceFloor?: number;
	signal?: AbortSignal;
};

const DEFAULT_LIMIT = 10;
const DEFAULT_CONTENT_BUDGET = 8_000;
const TOOL_PREVIEW_WIDTH = PREVIEW_LIMITS.OUTPUT_EXPANDED * TRUNCATE_LENGTHS.LONG;

function sanitizeToolText(value: string): string {
	return truncateToWidth(replaceTabs(shortenPath(value)), TOOL_PREVIEW_WIDTH);
}

function contentDigest(content: string): string {
	return crypto.createHash("sha256").update(new TextEncoder().encode(content)).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
	return undefined;
}
function numberField(value: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key];
	return undefined;
}
function list(body: SearchResult, key: string): unknown[] {
	return Array.isArray(body[key]) ? body[key] : [];
}
function normalizeRemote(body: SearchResult, kind: MemorySearchRemoteCandidate["kind"]): MemorySearchRemoteCandidate[] {
	if (kind !== "lesson") {
		return decodeAgentMemorySearchResults(body).map(entry => ({ ...entry, kind: entry.kind }));
	}
	const values = kind === "lesson" ? [...list(body, "lessons"), ...list(body, "results")] : [];
	return values.flatMap((entry, index) => {
		const value = record(entry);
		const content = value ? stringField(value, "content", "text", "summary", "description") : undefined;
		if (!value || !content) return [];
		return [
			{
				id: stringField(value, "id", "memoryId", "observationId", "lessonId") ?? `${kind}-${index}`,
				content,
				project: stringField(value, "project", "projectName"),
				agentId: stringField(value, "agentId", "agent_id", "agent"),
				sessionId: stringField(value, "sessionId", "session_id"),
				score: numberField(value, "score", "similarity", "relevance"),
				kind,
			} satisfies MemorySearchRemoteCandidate,
		];
	});
}

export function passesMemorySearchScope(candidate: MemorySearchRemoteCandidate, scope: MemorySearchScope): boolean {
	if (!candidate.project || candidate.project !== scope.project) return false;
	if (scope.agentId !== undefined && candidate.agentId !== scope.agentId) return false;
	if (scope.activeSessionId !== undefined && candidate.sessionId === scope.activeSessionId) return false;
	return true;
}
function dedupe<T extends { id: string; content: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	return items.filter(item => {
		const key = `${item.id}\u0000${item.content.trim()}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
function takeBudget(
	local: MemorySearchLocalCandidate[],
	remote: MemorySearchRemoteCandidate[],
	limit: number,
	budget: number,
	floor: number,
): { local: MemorySearchLocalCandidate[]; remote: MemorySearchRemoteCandidate[] } {
	const chosenLocal: MemorySearchLocalCandidate[] = [],
		chosenRemote: MemorySearchRemoteCandidate[] = [];
	let used = 0;
	const add = <T extends { content: string }>(item: T, target: T[]) => {
		if (
			target.includes(item) ||
			chosenLocal.length + chosenRemote.length >= limit ||
			used + item.content.length > budget
		)
			return;
		target.push(item);
		used += item.content.length;
	};
	for (const item of local.slice(0, floor)) add(item, chosenLocal);
	for (const item of remote.slice(0, floor)) add(item, chosenRemote);
	for (const item of local) add(item, chosenLocal);
	for (const item of remote) add(item, chosenRemote);
	return { local: chosenLocal, remote: chosenRemote };
}

export async function unifiedMemorySearch(
	localSearch: () => Promise<MemorySearchLocalCandidate[]>,
	client: AgentMemoryClientPort | undefined,
	scope: MemorySearchScope,
	query: string,
	options: MemorySearchOptions = {},
): Promise<MemorySearchResult> {
	const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
	const budget = Math.max(1, Math.floor(options.contentBudget ?? DEFAULT_CONTENT_BUDGET));
	const floor = Math.max(0, Math.min(Math.floor(options.perSourceFloor ?? 1), limit));
	const partial: string[] = [];
	const localPromise = localSearch().catch((error: unknown) => {
		partial.push(`Current session unavailable: ${String(error)}`);
		return [];
	});
	let remote: MemorySearchRemoteCandidate[] = [];
	if (client) {
		const input = {
			query,
			project: scope.project,
			...(scope.agentId ? { agentId: scope.agentId } : {}),
			limit: Math.max(limit * 2, floor),
		};
		const [memory, lessons] = await Promise.allSettled([
			client.search(input, { signal: options.signal }),
			scope.agentId === undefined
				? client.searchLessons(
						{ query, project: scope.project, limit: Math.max(limit * 2, floor) },
						{ signal: options.signal },
					)
				: Promise.resolve({ lessons: [] }),
		]);
		if (memory.status === "fulfilled") remote.push(...normalizeRemote(memory.value, "memory"));
		else partial.push(`Durable memory unavailable: ${String(memory.reason)}`);
		if (lessons.status === "fulfilled") remote.push(...normalizeRemote(lessons.value, "lesson"));
		else partial.push(`Lessons unavailable: ${String(lessons.reason)}`);
		const observationsNeedScope = remote.some(
			candidate => candidate.kind === "observation" && (!candidate.project || !candidate.sessionId),
		);
		if (observationsNeedScope && typeof client.listSessions === "function") {
			try {
				const sessions = await client.listSessions({ signal: options.signal });
				const byId = new Map(
					sessions.flatMap(session => {
						const id = session.id ?? session.sessionId;
						return id && session.project ? [[id, session] as const] : [];
					}),
				);
				remote = remote.map(candidate => {
					if (candidate.kind !== "observation" || candidate.project || !candidate.sessionId) return candidate;
					const session = byId.get(candidate.sessionId);
					return session ? { ...candidate, project: session.project, agentId: session.agentId } : candidate;
				});
			} catch {
				partial.push("Observation scope metadata unavailable");
			}
		}
		// Public search responses from older agentmemory versions may omit scope
		// metadata. Hydrate those records before applying the fail-closed gate.
		if (
			client &&
			remote.some(
				candidate =>
					candidate.kind !== "observation" &&
					(!candidate.project || (scope.agentId !== undefined && !candidate.agentId)) &&
					candidate.id,
			)
		) {
			remote = await Promise.all(
				remote.map(async candidate => {
					if (
						candidate.kind === "observation" ||
						(candidate.project && (scope.agentId === undefined || candidate.agentId)) ||
						!candidate.id
					)
						return candidate;
					try {
						const hydrated = await client.getMemory(candidate.id, { signal: options.signal });
						const value = hydrated as Record<string, unknown> | null;
						if (!value) return candidate;
						return {
							...candidate,
							project: stringField(value, "project", "projectName"),
							agentId: stringField(value, "agentId", "agent_id", "agent"),
							sessionId: stringField(value, "sessionId", "session_id"),
						};
					} catch {
						return candidate;
					}
				}),
			);
		}
	} else partial.push("Durable memory unavailable: bridge is disabled");
	const local = dedupe(await localPromise);
	remote = dedupe(remote.filter(candidate => passesMemorySearchScope(candidate, scope)));
	return { ...takeBudget(local, remote, limit, budget, floor), partial };
}

const ParamsSchema = Type.Object({
	query: Type.String({ description: "Search current session and durable memory." }),
	limit: Type.Optional(Type.Number()),
});
type Params = Static<typeof ParamsSchema>;
export type MemorySearchToolDeps = {
	search: (query: string, limit: number, signal: AbortSignal) => Promise<MemorySearchResult>;
	searchWithContext?: (
		query: string,
		limit: number,
		signal: AbortSignal,
		ctx: { cwd: string; sessionManager?: { getSessionId?: () => string | undefined } },
	) => Promise<MemorySearchResult>;
};
export function createMemorySearchTool(deps: MemorySearchToolDeps): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "memory_search",
		label: "Memory Search",
		description: "Search the current session and scoped durable memory in one operation.",
		parameters: ParamsSchema,
		async execute(_id, params: Params, signal, _onUpdate, ctx) {
			const result = await (deps.searchWithContext?.(
				params.query.trim(),
				Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT)),
				signal ?? new AbortController().signal,
				ctx,
			) ??
				deps.search(
					params.query.trim(),
					Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT)),
					signal ?? new AbortController().signal,
				));
			const sections: string[] = [];
			if (result.local.length)
				sections.push(
					`Current session\n${result.local.map((item, index) => `[${index + 1}] ${sanitizeToolText(item.content)}`).join("\n")}`,
				);
			if (result.remote.length)
				sections.push(
					`Durable memory (agentmemory)\n${result.remote.map((item, index) => `[${index + 1}] [${item.kind}] ${sanitizeToolText(item.content)}`).join("\n")}`,
				);
			if (!sections.length) sections.push("No matching memory found.");
			if (result.partial.length)
				sections.push(`Partial results\n${result.partial.map(sanitizeToolText).join("\n")}`);
			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: {
					local: result.local.map(item => ({ id: item.id })),
					remote: result.remote.map(item => ({
						id: item.id,
						kind: item.kind,
						project: item.project!,
						...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
						...(item.agentId === undefined ? {} : { agentId: item.agentId }),
						contentDigest: contentDigest(item.content),
					})),
					partial: result.partial,
				},
			};
		},
	};
}
