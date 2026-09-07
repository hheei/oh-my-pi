import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Database } from "../core/shared/sqlite";
import { log } from "#core/shared/logger";
import { registerAgentMemoryCapture, type AgentMemoryCaptureHandle } from "./capture.ts";
import { AgentMemoryClient, type AgentMemoryClientConfig, type AgentMemoryClientPort } from "./client.ts";
import { loadAgentMemorySettings, type AgentMemoryBridgeSettings } from "./config.ts";
import { createAgentMemoryProjectResolver } from "./project.ts";
import type { AgentMemoryProjectIdentity } from "./project.ts";
import { AgentMemorySessionManager, type AgentMemorySessionManagerOptions } from "./session.ts";

export interface AgentMemoryBridgeRuntime {
	readonly settings: AgentMemoryBridgeSettings;
	readonly client: AgentMemoryClientPort;
	readonly sessions: AgentMemorySessionManager;
	readonly capture: AgentMemoryCaptureHandle;
	readonly identity: (cwd: string) => AgentMemoryProjectIdentity;
}

export type AgentMemoryBridgeRuntimeOptions = {
	client?: AgentMemoryClientPort;
	clientOptions?: ConstructorParameters<typeof AgentMemoryClient>[1];
	activationId?: string;
	pi?: ExtensionAPI;
	db?: Database;
};

/** Build the narrow runtime shared by Capture and later search/inject slices. */
export function createAgentMemoryBridgeRuntime(
	settings: AgentMemoryBridgeSettings = loadAgentMemorySettings(),
	options: AgentMemoryBridgeRuntimeOptions = {},
): AgentMemoryBridgeRuntime {
	const client =
		options.client ??
		new AgentMemoryClient(
			{
				url: settings.url,
				secret: settings.secret,
				requireHttps: settings.requireHttps,
			} satisfies AgentMemoryClientConfig,
			options.clientOptions,
		);
	const resolveIdentity = createAgentMemoryProjectResolver(settings);
	const sessionOptions: AgentMemorySessionManagerOptions = {
		client,
		resolveIdentity,
		enabled: () => settings.enabled && settings.capture,
		onFailure: (operation, error) => {
			try {
				options.pi?.logger.warn("mctx agentmemory bridge request failed", { operation, error: String(error) });
				if (!options.pi) log(`[magic-context][agentmemory] ${operation} failed`, error);
			} catch {
				// Logging is best effort.
			}
		},
		...(options.activationId ? { activationId: options.activationId } : {}),
	};
	const sessions = new AgentMemorySessionManager(sessionOptions);
	const capture = registerAgentMemoryCapture(piOrNoop(options.pi), {
		settings: () => settings,
		sessions,
		onFailure: (operation, error) => {
			try {
				options.pi?.logger.warn("mctx agentmemory capture failed", { operation, error: String(error) });
				if (!options.pi) log(`[magic-context][agentmemory] ${operation} failed`, error);
			} catch {
				// Logging is best effort.
			}
		},
		db: options.db,
	});
	return { settings, client, sessions, capture, identity: resolveIdentity };
}

/** Register lifecycle handlers against a live Pi extension API. */
export function registerAgentMemoryBridge(
	pi: ExtensionAPI,
	settings: AgentMemoryBridgeSettings = loadAgentMemorySettings(),
	options: Omit<AgentMemoryBridgeRuntimeOptions, "pi"> = {},
): AgentMemoryBridgeRuntime {
	return createAgentMemoryBridgeRuntime(settings, { ...options, pi });
}

// Unit tests can build a runtime without a host API.  The no-op only receives
// event registrations and never performs work itself.
function piOrNoop(pi: ExtensionAPI | undefined): ExtensionAPI {
	if (pi) return pi;
	return {
		on: () => undefined,
	} as unknown as ExtensionAPI;
}
