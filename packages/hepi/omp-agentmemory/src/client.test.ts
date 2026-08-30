import { afterEach, describe, expect, test } from "bun:test";
import { request } from "./client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("request", () => {
	test("posts JSON under /agentmemory with bearer", async () => {
		const seen: { url: string; method: string; auth: string | null; body: string | null }[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({
				url: String(input),
				method: init?.method || "GET",
				auth: new Headers(init?.headers).get("Authorization"),
				body: typeof init?.body === "string" ? init.body : null,
			});
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as typeof fetch;

		const result = await request("remember", { url: "http://127.0.0.1:3111/", secret: "tok" }, {
			body: { content: "mctx-cutover-probe", project: "agentmemory-tailnet" },
		});
		expect(result).toEqual({ ok: true });
		expect(seen[0]?.url).toBe("http://127.0.0.1:3111/agentmemory/remember");
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.auth).toBe("Bearer tok");
		expect(seen[0]?.body).toContain("mctx-cutover-probe");
	});

	test("GET sessions path", async () => {
		let url = "";
		let method = "";
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			url = String(input);
			method = init?.method || "GET";
			return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
		}) as typeof fetch;
		const result = await request("sessions", { url: "http://127.0.0.1:3111", secret: "tok" }, { method: "GET" });
		expect(url).toBe("http://127.0.0.1:3111/agentmemory/sessions");
		expect(method).toBe("GET");
		expect(result).toEqual({ sessions: [] });
	});

	test("returns null on HTTP error", async () => {
		globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
		expect(await request("health", { url: "http://127.0.0.1:3111", secret: "" }, { method: "GET" })).toBeNull();
	});
});
