import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { registerCapture } from "./capture.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("capture tool_result", () => {
	test("isError posts hookType post_tool_failure", async () => {
		const observed: Record<string, unknown>[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
			if (url.endsWith("/agentmemory/health")) {
				return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
			}
			if (url.endsWith("/agentmemory/observe") && body) observed.push(body);
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as typeof fetch;

		const handlers: Record<string, (event: unknown, ctx?: ExtensionContext) => void> = {};
		const pi = {
			on(name: string, handler: (event: unknown, ctx?: ExtensionContext) => void) {
				handlers[name] = handler;
			},
		} as unknown as ExtensionAPI;

		const capture = registerCapture(pi, {
			enabled: () => true,
			config: () => ({ url: "http://127.0.0.1:3111", secret: "tok" }),
			project: () => "agentmemory-tailnet",
		});

		const ctx = {
			cwd: "/tmp",
			sessionManager: { getSessionFile: () => "/tmp/sess.jsonl" },
		} as unknown as ExtensionContext;
		await capture.onSessionReady(ctx);
		handlers.tool_result?.({
			toolName: "bash",
			input: { command: "false" },
			content: [{ type: "text", text: "exit 1" }],
			isError: true,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(observed).toHaveLength(1);
		expect(observed[0]?.hookType).toBe("post_tool_failure");
		expect(observed[0]?.data).toMatchObject({
			tool_name: "bash",
			tool_error: true,
			tool_output: "exit 1",
		});
	});
});
