import { DEFAULT_AGENTMEMORY_URL } from "./config.ts";
import { createPlaintextBearerAuthGuard } from "./security.ts";

export type AgentMemoryClientConfig = {
	url?: string;
	secret?: string;
	requireHttps?: boolean;
};

export type AgentMemoryRequestOptions = {
	timeoutMs?: number;
	signal?: AbortSignal;
};

export type HealthResult = {
	status?: string;
	version?: string;
	health?: { status?: string };
	[key: string]: unknown;
};

export type StartSessionInput = {
	sessionId: string;
	project: string;
	cwd: string;
	agentId?: string;
	[key: string]: unknown;
};

export type StartSessionResult = {
	sessionId?: string;
	startedAt?: string;
	[key: string]: unknown;
};

export type ObserveInput = {
	sessionId: string;
	project?: string;
	hookType: string;
	timestamp?: string;
	cwd?: string;
	data: Record<string, unknown>;
	[key: string]: unknown;
};

export type ObserveResult = {
	observationId?: string;
	deduplicated?: boolean;
	[key: string]: unknown;
};

export type SearchInput = {
	query: string;
	limit?: number;
	project: string;
	agentId?: string;
	format?: "full" | "compact" | "narrative" | string;
	[key: string]: unknown;
};

export type SearchResult = {
	results?: unknown[];
	observations?: unknown[];
	memories?: unknown[];
	[key: string]: unknown;
};

export type DecodedSearchEntry = {
	id: string;
	content: string;
	kind: "memory" | "observation";
	project?: string;
	agentId?: string;
	sessionId?: string;
	score?: number;
};

export type LessonSearchInput = {
	query: string;
	limit?: number;
	project: string;
	[key: string]: unknown;
};

export type LessonSearchResult = {
	results?: unknown[];
	lessons?: unknown[];
	[key: string]: unknown;
};

export type Memory = {
	id: string;
	project?: string;
	agentId?: string;
	[key: string]: unknown;
};

export type Session = {
	id?: string;
	sessionId?: string;
	project?: string;
	agentId?: string;
	[key: string]: unknown;
};

export type MemoryListInput = {
	latest?: boolean | string;
	limit?: number;
	offset?: number;
	project?: string;
	agentId?: string;
	[key: string]: unknown;
};

export type MemoryPage = {
	memories?: Memory[];
	results?: Memory[];
	total?: number;
	[key: string]: unknown;
};

export type RememberInput = {
	content: string;
	type?: string;
	project: string;
	agentId?: string;
	concepts?: string[];
	files?: string[];
	sourceObservationIds?: string[];
	[key: string]: unknown;
};

export type RememberResult = {
	success: true;
	memory: Memory;
	[key: string]: unknown;
};

export type AgentMemoryClientErrorKind =
	| "invalid_url"
	| "insecure_transport"
	| "http"
	| "network"
	| "timeout"
	| "cancelled"
	| "invalid_response";

export class AgentMemoryClientError extends Error {
	readonly kind: AgentMemoryClientErrorKind;
	readonly endpoint: string;
	readonly status?: number;

	constructor(kind: AgentMemoryClientErrorKind, endpoint: string, message: string, status?: number, cause?: unknown) {
		super(message, { cause });
		this.name = "AgentMemoryClientError";
		this.kind = kind;
		this.endpoint = endpoint;
		if (status !== undefined) this.status = status;
	}
}

export interface AgentMemoryClientPort {
	health(options?: AgentMemoryRequestOptions): Promise<HealthResult>;
	startSession(input: StartSessionInput, options?: AgentMemoryRequestOptions): Promise<StartSessionResult>;
	observe(input: ObserveInput, options?: AgentMemoryRequestOptions): Promise<ObserveResult>;
	search(input: SearchInput, options?: AgentMemoryRequestOptions): Promise<SearchResult>;
	searchLessons(input: LessonSearchInput, options?: AgentMemoryRequestOptions): Promise<LessonSearchResult>;
	getMemory(id: string, options?: AgentMemoryRequestOptions): Promise<Memory | null>;
	listSessions(options?: AgentMemoryRequestOptions): Promise<Session[]>;
	listMemories(input?: MemoryListInput, options?: AgentMemoryRequestOptions): Promise<MemoryPage>;
	remember(input: RememberInput, options?: AgentMemoryRequestOptions): Promise<RememberResult>;
	endSession(sessionId: string, options?: AgentMemoryRequestOptions): Promise<void>;
}

type FetchLike = typeof fetch;

type ClientOptions = {
	fetch?: FetchLike;
	defaults?: Partial<
		Record<
			"health" | "startSession" | "observe" | "search" | "searchLessons" | "scope" | "remember" | "endSession",
			number
		>
	>;
	warn?: (message: string) => void;
};

const DEFAULT_TIMEOUTS = {
	health: 1_000,
	startSession: 3_000,
	observe: 1_500,
	search: 3_000,
	searchLessons: 2_000,
	scope: 3_000,
	remember: 4_000,
	endSession: 2_000,
} as const;
type AgentMemoryTimeouts = Record<keyof typeof DEFAULT_TIMEOUTS, number>;

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function searchContent(value: Record<string, unknown>): string | undefined {
	for (const key of ["content", "text", "narrative", "summary", "description"] as const) {
		const content = nonEmpty(value[key]);
		if (content) return content;
	}
	if (!Array.isArray(value.facts)) return undefined;
	const facts = value.facts.flatMap(fact => {
		if (typeof fact === "string") return nonEmpty(fact) ?? [];
		const entry = record(fact);
		if (!entry) return [];
		return nonEmpty(entry.content) ?? nonEmpty(entry.text) ?? nonEmpty(entry.fact) ?? [];
	});
	return facts.length > 0 ? facts.join("\n") : undefined;
}

/** Decode the public v0.9 search envelope, including `{ observation, score, sessionId }` rows. */
export function decodeAgentMemorySearchResults(body: SearchResult): DecodedSearchEntry[] {
	const sources: Array<{ values: unknown[]; kind: DecodedSearchEntry["kind"] }> = [
		{ values: Array.isArray(body.results) ? body.results : [], kind: "memory" },
		{ values: Array.isArray(body.memories) ? body.memories : [], kind: "memory" },
		{ values: Array.isArray(body.observations) ? body.observations : [], kind: "observation" },
	];
	return sources.flatMap(({ values, kind }) =>
		values.flatMap((raw, index) => {
			const wrapper = record(raw);
			if (!wrapper) return [];
			const nestedObservation = record(wrapper.observation);
			const nestedMemory = record(wrapper.memory);
			const value = nestedObservation ?? nestedMemory ?? wrapper;
			const resolvedKind = nestedObservation ? "observation" : kind;
			const content = searchContent(value);
			if (!content) return [];
			const id =
				nonEmpty(value.id) ??
				nonEmpty(value.observationId) ??
				nonEmpty(value.memoryId) ??
				nonEmpty(wrapper.id) ??
				`${resolvedKind}-${index}`;
			const project = nonEmpty(value.project) ?? nonEmpty(value.projectName) ?? nonEmpty(wrapper.project);
			const agentId =
				nonEmpty(value.agentId) ??
				nonEmpty(value.agent_id) ??
				nonEmpty(wrapper.agentId) ??
				nonEmpty(wrapper.agent_id);
			const sessionId =
				nonEmpty(wrapper.sessionId) ??
				nonEmpty(wrapper.session_id) ??
				nonEmpty(value.sessionId) ??
				nonEmpty(value.session_id);
			const score = typeof wrapper.score === "number" && Number.isFinite(wrapper.score) ? wrapper.score : undefined;
			return [{ id, content, kind: resolvedKind, project, agentId, sessionId, score }];
		}),
	);
}

function successfulBody(value: unknown, endpoint: string): Record<string, unknown> {
	const body = record(value);
	if (!body)
		throw new AgentMemoryClientError("invalid_response", endpoint, "agentmemory returned a non-object JSON body");
	if (body.success === false || body.ok === false) {
		throw new AgentMemoryClientError("invalid_response", endpoint, "agentmemory reported an unsuccessful response");
	}
	const status = typeof body.status === "string" ? body.status.toLowerCase() : "";
	if (["error", "failed", "failure", "unhealthy"].includes(status)) {
		throw new AgentMemoryClientError("invalid_response", endpoint, `agentmemory reported status ${body.status}`);
	}
	return body;
}

function healthBody(value: unknown): HealthResult {
	const body = successfulBody(value, "health") as HealthResult;
	const status = nonEmpty(body.status) ?? nonEmpty(body.health?.status);
	if (!status || !["ok", "healthy", "ready", "up"].includes(status.toLowerCase())) {
		throw new AgentMemoryClientError(
			"invalid_response",
			"health",
			"agentmemory health response has no healthy status",
		);
	}
	return body;
}

function sessionStartBody(value: unknown, requestedId: string): StartSessionResult {
	const body = successfulBody(value, "session/start") as StartSessionResult;
	const returnedId =
		nonEmpty(body.sessionId) ??
		nonEmpty((body.session as Record<string, unknown> | undefined)?.id) ??
		nonEmpty(body.id);
	if (!returnedId && body.started !== true && body.ok !== true && body.success !== true) {
		throw new AgentMemoryClientError(
			"invalid_response",
			"session/start",
			"session/start response did not confirm a session",
		);
	}
	return { ...body, ...(returnedId ? { sessionId: returnedId } : { sessionId: requestedId }) };
}

function observeBody(value: unknown): ObserveResult {
	const body = successfulBody(value, "observe") as ObserveResult;
	if (Object.keys(body).length === 0) {
		throw new AgentMemoryClientError("invalid_response", "observe", "observe response is empty");
	}
	const observationId = nonEmpty(body.observationId) ?? nonEmpty(body.id);
	return observationId ? { ...body, observationId } : body;
}

function searchBody(value: unknown, endpoint: string): SearchResult {
	const body = successfulBody(value, endpoint) as SearchResult;
	if (!["results", "observations", "memories", "lessons"].some(key => Array.isArray(body[key]))) {
		throw new AgentMemoryClientError("invalid_response", endpoint, `${endpoint} response has no result list`);
	}
	return body;
}

function memoryBody(value: unknown): Memory {
	const body = successfulBody(value, "memories/:id");
	const candidate = record(body.memory) ?? body;
	const id = nonEmpty(candidate.id);
	if (!id) throw new AgentMemoryClientError("invalid_response", "memories/:id", "memory response has no id");
	return { ...candidate, id } as Memory;
}

function rememberBody(value: unknown): RememberResult {
	const body = successfulBody(value, "remember");
	if (body.success !== true) {
		throw new AgentMemoryClientError("invalid_response", "remember", "remember response did not confirm success");
	}
	const memory = record(body.memory);
	const id = nonEmpty(memory?.id);
	if (!memory || !id)
		throw new AgentMemoryClientError("invalid_response", "remember", "remember response has no memory id");
	return { ...body, memory: { ...memory, id } as Memory, success: true } as RememberResult;
}

function listBody(value: unknown, endpoint: string): Record<string, unknown> {
	const body = successfulBody(value, endpoint);
	if (Object.keys(body).length === 0)
		throw new AgentMemoryClientError("invalid_response", endpoint, `${endpoint} response is empty`);
	return body;
}

export class AgentMemoryClient implements AgentMemoryClientPort {
	readonly #baseUrl: string;
	readonly #secret: string;
	readonly #fetch: FetchLike;
	readonly #timeouts: AgentMemoryTimeouts;
	readonly #guard: (baseUrl: string, secret?: string) => void;

	constructor(config: AgentMemoryClientConfig = {}, options: ClientOptions = {}) {
		const url = normalizeBaseUrl(config.url?.trim() || DEFAULT_AGENTMEMORY_URL);
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
		} catch (error) {
			throw new AgentMemoryClientError("invalid_url", "client", `Invalid agentmemory URL: ${url}`, undefined, error);
		}
		this.#baseUrl = url;
		this.#secret = config.secret?.trim() ?? "";
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.defaults };
		this.#guard = createPlaintextBearerAuthGuard({
			requireHttps: config.requireHttps,
			warn: options.warn,
		});
	}

	async health(options?: AgentMemoryRequestOptions): Promise<HealthResult> {
		return healthBody(await this.#request("health", "GET", undefined, options, this.#timeouts.health));
	}

	async startSession(input: StartSessionInput, options?: AgentMemoryRequestOptions): Promise<StartSessionResult> {
		return sessionStartBody(
			await this.#request("session/start", "POST", input, options, this.#timeouts.startSession),
			input.sessionId,
		);
	}

	async observe(input: ObserveInput, options?: AgentMemoryRequestOptions): Promise<ObserveResult> {
		return observeBody(
			await this.#request(
				"observe",
				"POST",
				{ timestamp: new Date().toISOString(), ...input },
				options,
				this.#timeouts.observe,
			),
		);
	}

	async search(input: SearchInput, options?: AgentMemoryRequestOptions): Promise<SearchResult> {
		return searchBody(
			await this.#request("search", "POST", { format: "full", ...input }, options, this.#timeouts.search),
			"search",
		);
	}

	async searchLessons(input: LessonSearchInput, options?: AgentMemoryRequestOptions): Promise<LessonSearchResult> {
		return searchBody(
			await this.#request("lessons/search", "POST", input, options, this.#timeouts.searchLessons),
			"lessons/search",
		) as LessonSearchResult;
	}

	async getMemory(id: string, options?: AgentMemoryRequestOptions): Promise<Memory | null> {
		const encoded = encodeURIComponent(id);
		try {
			return memoryBody(await this.#request(`memories/${encoded}`, "GET", undefined, options, this.#timeouts.scope));
		} catch (error) {
			if (error instanceof AgentMemoryClientError && error.kind === "http" && error.status === 404) return null;
			throw error;
		}
	}

	async listSessions(options?: AgentMemoryRequestOptions): Promise<Session[]> {
		const body = listBody(
			await this.#request("sessions", "GET", undefined, options, this.#timeouts.scope),
			"sessions",
		);
		const sessions = body.sessions ?? body.results;
		if (!Array.isArray(sessions))
			throw new AgentMemoryClientError("invalid_response", "sessions", "sessions response has no session list");
		return sessions.filter((entry): entry is Session => record(entry) !== null) as Session[];
	}

	async listMemories(input: MemoryListInput = {}, options?: AgentMemoryRequestOptions): Promise<MemoryPage> {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(input)) {
			if (value !== undefined) params.set(key, String(value));
		}
		const path = params.size > 0 ? `memories?${params.toString()}` : "memories";
		const body = listBody(await this.#request(path, "GET", undefined, options, this.#timeouts.scope), "memories");
		const memories = body.memories ?? body.results;
		if (!Array.isArray(memories))
			throw new AgentMemoryClientError("invalid_response", "memories", "memories response has no memory list");
		return {
			...body,
			memories: memories.filter((entry): entry is Memory => record(entry) !== null) as Memory[],
		} as MemoryPage;
	}

	async remember(input: RememberInput, options?: AgentMemoryRequestOptions): Promise<RememberResult> {
		return rememberBody(await this.#request("remember", "POST", input, options, this.#timeouts.remember));
	}

	async endSession(sessionId: string, options?: AgentMemoryRequestOptions): Promise<void> {
		const body = listBody(
			await this.#request("session/end", "POST", { sessionId }, options, this.#timeouts.endSession),
			"session/end",
		);
		if (body.ended === false || body.success === false || body.ok === false) {
			throw new AgentMemoryClientError(
				"invalid_response",
				"session/end",
				"session/end response did not confirm completion",
			);
		}
	}

	async #request(
		pathname: string,
		method: "GET" | "POST",
		body: unknown,
		options: AgentMemoryRequestOptions | undefined,
		defaultTimeoutMs: number,
	): Promise<unknown> {
		const endpoint = pathname.split("?")[0] ?? pathname;
		this.#guard(this.#baseUrl, this.#secret);
		const headers = new Headers();
		if (this.#secret) headers.set("Authorization", `Bearer ${this.#secret}`);
		if (body !== undefined) headers.set("Content-Type", "application/json");
		const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		try {
			response = await this.#fetch(`${this.#baseUrl}/agentmemory/${pathname.replace(/^\/+/, "")}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
			});
		} catch (error) {
			const aborted = signal.aborted;
			const timeout = timeoutSignal.aborted && !options?.signal?.aborted;
			throw new AgentMemoryClientError(
				timeout ? "timeout" : aborted ? "cancelled" : "network",
				endpoint,
				timeout ? `agentmemory ${endpoint} timed out` : `agentmemory ${endpoint} request failed`,
				undefined,
				error,
			);
		}
		if (!response.ok) {
			throw new AgentMemoryClientError(
				"http",
				endpoint,
				`agentmemory ${endpoint} returned HTTP ${response.status}`,
				response.status,
			);
		}
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch (error) {
			throw new AgentMemoryClientError(
				"invalid_response",
				endpoint,
				`agentmemory ${endpoint} returned invalid JSON`,
				response.status,
				error,
			);
		}
		return parsed;
	}
}

export function createAgentMemoryClient(
	config: AgentMemoryClientConfig = {},
	options: ClientOptions = {},
): AgentMemoryClient {
	return new AgentMemoryClient(config, options);
}
