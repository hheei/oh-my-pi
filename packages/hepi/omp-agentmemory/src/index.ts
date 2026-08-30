import { getPluginSettings, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCapture } from "./capture.ts";
import { request, type AgentmemoryConfig } from "./client.ts";
import { normalizeBaseUrl } from "./format.ts";
import { resolveProjectName } from "./project.ts";
import { registerTools } from "./tools.ts";

const PLUGIN = "@hheei/omp-agentmemory";
const DEFAULT_URL = "http://127.0.0.1:3111";

type Settings = {
	enabled: boolean;
	url: string;
	secret: string;
	project: string;
};

type HealthResponse = {
	status?: string;
	version?: string;
	health?: { status?: string };
};

function envSettings(): Settings {
	return {
		enabled: false,
		url: process.env.AGENTMEMORY_URL?.trim() || DEFAULT_URL,
		secret: process.env.AGENTMEMORY_SECRET?.trim() || "",
		project: process.env.AGENTMEMORY_PROJECT_NAME?.trim() || "",
	};
}

function mergeSettings(raw: Record<string, unknown>): Settings {
	const env = envSettings();
	return {
		enabled: raw.enabled === true,
		url: env.url !== DEFAULT_URL ? env.url : typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : DEFAULT_URL,
		secret: env.secret || (typeof raw.secret === "string" ? raw.secret : ""),
		project: env.project || (typeof raw.project === "string" ? raw.project.trim() : ""),
	};
}

function healthLabel(health: HealthResponse | null, url: string): string {
	if (!health) return `agentmemory unreachable at ${url}`;
	const status = health.status || health.health?.status || "unknown";
	return `agentmemory ${status}${health.version ? ` v${health.version}` : ""}`;
}

export default function ompAgentmemory(pi: ExtensionAPI): void {
	let settings = envSettings();

	const load = async (cwd: string) => {
		try {
			settings = mergeSettings(await getPluginSettings(PLUGIN, cwd));
		} catch (error) {
			pi.logger.warn("Failed to load omp-agentmemory settings; using env defaults (disabled)", {
				error: String(error),
			});
			settings = envSettings();
		}
	};

	const runtime = {
		enabled: () => settings.enabled,
		config: (): AgentmemoryConfig => ({
			url: normalizeBaseUrl(process.env.AGENTMEMORY_URL?.trim() || settings.url || DEFAULT_URL),
			secret: process.env.AGENTMEMORY_SECRET?.trim() || settings.secret,
		}),
		project: (cwd: string) => resolveProjectName(cwd, settings.project),
	};

	const capture = registerCapture(pi, runtime);

	pi.on("session_start", async (_event, ctx) => {
		await load(ctx.cwd);
		await capture.onSessionReady(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		await load(ctx.cwd);
		await capture.onSessionReady(ctx);
	});

	pi.registerCommand("memory-health", {
		description: "Probe agentmemory health",
		handler: async (_args, ctx) => {
			const config = runtime.config();
			const health = await request<HealthResponse>("health", config, { method: "GET" });
			ctx.ui.notify(healthLabel(health, config.url), health ? "info" : "warning");
		},
	});

	registerTools(pi, runtime);
}
