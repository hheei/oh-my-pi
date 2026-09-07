import { describe, expect, it, vi } from "vitest";
import {
	AgentMemoryClient,
	AgentMemoryClientError,
	} from "../src/agentmemory/client";
import { resolveAgentMemorySettings } from "../src/agentmemory/config";
import { isExcludedMemoryTool, redactCaptureText, redactCaptureValue } from "../src/agentmemory/capture";
import { AgentMemorySessionManager } from "../src/agentmemory/session";

describe("mctx agentmemory bridge foundation", () => {
	it("keeps the bridge disabled while applying environment URL and secret precedence", () => {
		const settings = resolveAgentMemorySettings(
			{ agentmemory: { enabled: false, url: "http://configured", secret: "configured" } },
			{ AGENTMEMORY_URL: "https://environment", AGENTMEMORY_SECRET: "environment" },
		);

		expect(settings).toMatchObject({ enabled: false, url: "https://environment", secret: "environment" });
		expect(settings.capture).toBe(true);
		expect(settings.inject).toBe(true);
	});

	it("rejects a healthy HTTP response whose JSON body is not healthy", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			new Response(JSON.stringify({ status: "degraded" }), { status: 200 }),
		);
		const client = new AgentMemoryClient({ url: "http://127.0.0.1:3111" }, { fetch });

		await expect(client.health()).rejects.toMatchObject<Partial<AgentMemoryClientError>>({
			kind: "invalid_response",
			endpoint: "health",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("redacts credential-shaped values and excludes memory tools from capture", () => {
		const text = redactCaptureText("Authorization: Bearer abc123 and api_key=secret-value");
		const value = redactCaptureValue({ password: "hidden", nested: "token=abc" });

		expect(text).toContain("Authorization: Bearer [REDACTED]");
		expect(text).toContain("api_key=[REDACTED]");
		expect(value).toEqual({ password: "[REDACTED]", nested: "token=[REDACTED]" });
		expect(isExcludedMemoryTool("memory_search")).toBe(true);
		expect(isExcludedMemoryTool("shell")).toBe(false);
	});

	it("starts one remote segment per OMP session and ends all active segments", async () => {
		const starts: string[] = [];
		const ends: string[] = [];
		const client = {
			health: vi.fn(async () => ({ status: "ok" })),
			startSession: vi.fn(async (input: { sessionId: string }) => {
				starts.push(input.sessionId);
				return { sessionId: input.sessionId };
			}),
			observe: vi.fn(async () => ({})),
			endSession: vi.fn(async (id: string) => {
				ends.push(id);
			}),
		} as never;
		const manager = new AgentMemorySessionManager({
			client,
			activationId: "activation",
			resolveIdentity: () => ({ cwd: "/repo", agentmemoryProject: "repo" }),
		});
		const context = { cwd: "/repo", sessionManager: { getSessionId: () => "omp-session" } };

		const first = await manager.startForContext(context);
		const second = await manager.startForContext(context);
		await manager.endAll();
		await manager.endAll();

		expect(first?.agentmemorySessionId).toBe(second?.agentmemorySessionId);
		expect(starts).toHaveLength(1);
		expect(ends).toEqual([starts[0]]);
	});
});
