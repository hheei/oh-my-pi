import crypto from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { request, type AgentmemoryConfig } from "./client.ts";
import { isDuplicate } from "./dedup.ts";
import { getLastAssistantText, getText } from "./text.ts";

export type CaptureRuntime = {
	enabled: () => boolean;
	config: () => AgentmemoryConfig;
	project: (cwd: string) => string;
};

type HealthResponse = {
	status?: string;
	health?: { status?: string };
};

function sessionIdFrom(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	return sessionFile ? path.basename(sessionFile).replace(/\.[^.]+$/, "") : `ephemeral-${crypto.randomUUID().slice(0, 8)}`;
}

function healthy(health: HealthResponse | null): boolean {
	return (
		!!health &&
		(health.status === "ok" || health.status === "healthy" || health.health?.status === "healthy")
	);
}

export function registerCapture(
	pi: ExtensionAPI,
	runtime: CaptureRuntime,
): { onSessionReady: (ctx: ExtensionContext) => Promise<void> } {
	let sessionId = `ephemeral-${crypto.randomUUID().slice(0, 8)}`;
	let lastPrompt = "";
	let lastHealthOk = false;
	let cwd = process.cwd();

	async function refreshHealth(): Promise<boolean> {
		const health = await request<HealthResponse>("health", runtime.config(), { method: "GET" });
		lastHealthOk = healthy(health);
		return lastHealthOk;
	}

	function observe(hookType: string, data: Record<string, unknown>): void {
		if (!runtime.enabled() || !lastHealthOk) return;
		void request("observe", runtime.config(), {
			body: {
				hookType,
				sessionId,
				project: runtime.project(cwd),
				cwd,
				timestamp: new Date().toISOString(),
				data,
			},
		});
	}

	async function onSessionReady(ctx: ExtensionContext): Promise<void> {
		cwd = ctx.cwd;
		sessionId = sessionIdFrom(ctx);
		if (!runtime.enabled()) return;
		if (!(await refreshHealth())) return;
		await request("session/start", runtime.config(), {
			body: { sessionId, project: runtime.project(cwd), cwd },
		});
	}

	pi.on("before_agent_start", async (event, ctx) => {
		cwd = ctx.cwd;
		lastPrompt = event.prompt?.trim() || "";
		if (!lastPrompt || !runtime.enabled()) return;
		if (!lastHealthOk) await refreshHealth();
		if (!lastHealthOk) return;
		if (!isDuplicate(`prompt_submit:${sessionId}:${lastPrompt}`)) {
			observe("prompt_submit", { prompt: lastPrompt });
		}
	});

	pi.on("tool_result", (event) => {
		if (!runtime.enabled() || !lastHealthOk || !event.toolName) return;
		let input = "";
		try {
			input = typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {});
		} catch {
			// non-serializable
		}
		observe(event.isError ? "post_tool_failure" : "post_tool_use", {
			tool_name: event.toolName,
			tool_input: input.slice(0, 8000),
			tool_output: getText(event.content).slice(0, 8000),
			...(event.isError ? { tool_error: true } : {}),
		});
	});

	pi.on("agent_end", (event) => {
		if (!runtime.enabled() || !lastHealthOk || !lastPrompt || event.willContinue) return;
		const assistantText = getLastAssistantText(event.messages as unknown[]);
		if (!assistantText) return;
		observe("post_tool_use", {
			tool_name: "conversation",
			tool_input: lastPrompt.slice(0, 8000),
			tool_output: assistantText.slice(0, 8000),
		});
	});

	pi.on("session_shutdown", async () => {
		if (!runtime.enabled() || !lastHealthOk || !sessionId) return;
		await request("session/end", runtime.config(), {
			body: { sessionId },
			timeoutMs: 5_000,
		});
		void request("consolidate", runtime.config(), { body: {} });
	});

	return { onSessionReady };
}
