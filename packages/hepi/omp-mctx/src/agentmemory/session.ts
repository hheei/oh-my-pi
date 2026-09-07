import * as crypto from "node:crypto";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentMemoryClientPort, ObserveInput, ObserveResult } from "./client.ts";
import type { AgentMemoryProjectIdentity } from "./project.ts";

export interface AgentMemorySessionBinding {
	ompSessionId: string;
	agentmemorySessionId: string;
	project: string;
	agentId?: string;
	cwd: string;
	ended: boolean;
}

export type AgentMemoryIdentityResolver = (cwd: string) => AgentMemoryProjectIdentity;

export type AgentMemorySessionContext =
	| Pick<ExtensionContext, "cwd" | "sessionManager">
	| {
			cwd: string;
			sessionManager?: {
				getSessionId?: () => string | undefined;
				getSessionFile?: () => string | undefined;
				getBranch?: () => readonly unknown[];
			};
	  };

export type AgentMemorySessionManagerOptions = {
	client: AgentMemoryClientPort;
	resolveIdentity: AgentMemoryIdentityResolver;
	enabled?: () => boolean;
	onFailure?: (operation: string, error: unknown) => void;
	activationId?: string;
};

export function resolveOmpSessionId(context: AgentMemorySessionContext): string {
	const fromManager = context.sessionManager?.getSessionId?.();
	if (typeof fromManager === "string" && fromManager.trim()) return fromManager.trim();
	const sessionFile = context.sessionManager?.getSessionFile?.();
	if (typeof sessionFile === "string" && sessionFile.trim()) {
		const basename = path.basename(sessionFile.trim());
		const id = basename.replace(/\.[^.]+$/, "");
		if (id) return id;
	}
	return "ephemeral-unknown";
}

/** Resolve the remote capture segment currently bound to a host context. */
export function resolveAgentMemorySessionId(
	manager: AgentMemorySessionManager,
	context: AgentMemorySessionContext,
): string | undefined {
	return manager.getBinding(resolveOmpSessionId(context))?.agentmemorySessionId;
}

/**
 * Owns OMP-session -> remote capture-segment bindings for one process
 * activation.  Switching sessions never ends the outgoing segment because
 * Pi navigation is reversible; terminal shutdown ends every live segment.
 */
export class AgentMemorySessionManager {
	readonly #client: AgentMemoryClientPort;
	readonly #resolveIdentity: AgentMemoryIdentityResolver;
	readonly #enabled: () => boolean;
	readonly #onFailure?: (operation: string, error: unknown) => void;
	readonly #activationId: string;
	readonly #bindings = new Map<string, AgentMemorySessionBinding>();
	readonly #starting = new Map<string, Promise<AgentMemorySessionBinding | null>>();
	readonly #ending = new Map<string, Promise<void>>();
	#shuttingDown = false;

	constructor(options: AgentMemorySessionManagerOptions) {
		this.#client = options.client;
		this.#resolveIdentity = options.resolveIdentity;
		this.#enabled = options.enabled ?? (() => true);
		this.#onFailure = options.onFailure;
		this.#activationId = options.activationId?.trim() || `omp-${crypto.randomUUID()}`;
	}

	get bindings(): readonly AgentMemorySessionBinding[] {
		return [...this.#bindings.values()].map(binding => ({ ...binding }));
	}

	get activeBindings(): readonly AgentMemorySessionBinding[] {
		return this.bindings.filter(binding => !binding.ended);
	}

	getBinding(ompSessionId: string): AgentMemorySessionBinding | undefined {
		const binding = this.#bindings.get(ompSessionId);
		return binding ? { ...binding } : undefined;
	}

	async startForContext(context: AgentMemorySessionContext): Promise<AgentMemorySessionBinding | null> {
		if (this.#shuttingDown || !this.#enabled()) return null;
		const ompSessionId = resolveOmpSessionId(context);
		const existing = this.#bindings.get(ompSessionId);
		if (existing) return { ...existing };
		const current = this.#starting.get(ompSessionId);
		if (current) return current;

		const pending = this.#start(ompSessionId, context);
		this.#starting.set(ompSessionId, pending);
		try {
			return await pending;
		} finally {
			if (this.#starting.get(ompSessionId) === pending) this.#starting.delete(ompSessionId);
		}
	}

	async observeForContext(
		context: AgentMemorySessionContext,
		input: {
			hookType: string;
			data: Record<string, unknown>;
			timestamp?: string;
			cwd?: string;
			project?: string;
		},
	): Promise<ObserveResult | null> {
		const binding = this.#bindings.get(resolveOmpSessionId(context));
		if (!binding || binding.ended || this.#shuttingDown) return null;
		try {
			const observation: ObserveInput = {
				hookType: input.hookType,
				data: input.data,
				timestamp: input.timestamp ?? new Date().toISOString(),
				...(input.cwd ? { cwd: input.cwd } : {}),
				sessionId: binding.agentmemorySessionId,
				project: binding.project,
			};
			return await this.#client.observe(observation);
		} catch (error) {
			this.#reportFailure("observe", error);
			return null;
		}
	}

	async endAll(): Promise<void> {
		this.#shuttingDown = true;
		// A start in flight may have already passed the remote health check. Wait
		// for it before taking the binding snapshot so shutdown cannot strand it.
		await Promise.allSettled(this.#starting.values());
		const endings = [...this.#bindings.values()].filter(binding => !binding.ended).map(binding => this.#end(binding));
		await Promise.allSettled(endings);
	}

	async #start(ompSessionId: string, context: AgentMemorySessionContext): Promise<AgentMemorySessionBinding | null> {
		const remoteSessionId = `${this.#activationId}:${crypto.randomUUID()}`;
		try {
			const identity = this.#resolveIdentity(context.cwd);
			await this.#client.health();
			const result = await this.#client.startSession({
				sessionId: remoteSessionId,
				project: identity.agentmemoryProject,
				cwd: context.cwd,
				...(identity.agentId ? { agentId: identity.agentId } : {}),
			});
			const binding: AgentMemorySessionBinding = {
				ompSessionId,
				agentmemorySessionId: result.sessionId ?? remoteSessionId,
				project: identity.agentmemoryProject,
				...(identity.agentId ? { agentId: identity.agentId } : {}),
				cwd: context.cwd,
				ended: false,
			};
			this.#bindings.set(ompSessionId, binding);
			return { ...binding };
		} catch (error) {
			this.#reportFailure("session/start", error);
			return null;
		}
	}

	async #end(binding: AgentMemorySessionBinding): Promise<void> {
		const current = this.#ending.get(binding.agentmemorySessionId);
		if (current) return current;
		const ending = this.#finish(binding);
		this.#ending.set(binding.agentmemorySessionId, ending);
		try {
			await ending;
		} finally {
			if (this.#ending.get(binding.agentmemorySessionId) === ending)
				this.#ending.delete(binding.agentmemorySessionId);
		}
	}

	async #finish(binding: AgentMemorySessionBinding): Promise<void> {
		const current = this.#bindings.get(binding.ompSessionId);
		if (!current || current.ended) return;
		// Mark before dispatch: repeated shutdown hooks must not issue a second
		// non-idempotent end request, even when the first request is slow/fails.
		current.ended = true;
		try {
			await this.#client.endSession(current.agentmemorySessionId);
		} catch (error) {
			this.#reportFailure("session/end", error);
		}
	}

	#reportFailure(operation: string, error: unknown): void {
		try {
			this.#onFailure?.(operation, error);
		} catch {
			// Observability must never become a runtime dependency.
		}
	}
}
