import * as path from "node:path";
import type { AgentMemoryBridgeSettings } from "./config.ts";
import { resolveProjectIdentityForSession } from "../core/features/memory/project-identity.ts";

export interface AgentMemoryProjectIdentity {
	cwd: string;
	agentmemoryProject: string;
	agentId?: string;
}

export interface AgentMemoryProjectEnvironment {
	AGENTMEMORY_PROJECT_NAME?: string;
	AGENT_ID?: string;
}

const projectCache = new Map<string, string>();

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the backend project namespace.  This intentionally differs from
 * mctx's stable hash identity: agentmemory's public integration uses the git
 * root basename so repositories can share a backend across worktrees.
 */
export function resolveAgentMemoryProject(
	directory: string,
	explicit?: string,
	environment: AgentMemoryProjectEnvironment = process.env as AgentMemoryProjectEnvironment,
): string {
	const configured = nonEmpty(environment.AGENTMEMORY_PROJECT_NAME) ?? nonEmpty(explicit);
	if (configured) return configured;

	const resolvedDirectory = path.resolve(directory);
	const cached = projectCache.get(resolvedDirectory);
	if (cached) return cached;

	let project = path.basename(resolvedDirectory) || resolvedDirectory;
	try {
		const identity = resolveProjectIdentityForSession(resolvedDirectory, true);
		if (identity) project = identity;
	} catch {
		// A non-git cwd is a supported fallback, not an integration failure.
	}
	projectCache.set(resolvedDirectory, project);
	return project;
}

export function createAgentMemoryProjectResolver(
	settings: Pick<AgentMemoryBridgeSettings, "project" | "agentId">,
	environment: AgentMemoryProjectEnvironment = process.env as AgentMemoryProjectEnvironment,
): (cwd: string) => AgentMemoryProjectIdentity {
	return cwd => {
		const agentId = nonEmpty(environment.AGENT_ID) ?? nonEmpty(settings.agentId);
		return {
			cwd,
			agentmemoryProject: resolveAgentMemoryProject(cwd, settings.project, environment),
			...(agentId ? { agentId } : {}),
		};
	};
}

export function resolveAgentMemoryIdentity(
	cwd: string,
	settings: Pick<AgentMemoryBridgeSettings, "project" | "agentId">,
	environment: AgentMemoryProjectEnvironment = process.env as AgentMemoryProjectEnvironment,
): AgentMemoryProjectIdentity {
	return createAgentMemoryProjectResolver(settings, environment)(cwd);
}

export function clearAgentMemoryProjectCache(): void {
	projectCache.clear();
}
