import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerTools } from "./tools.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function chain() {
	const self = {
		describe() {
			return self;
		},
		optional() {
			return self;
		},
		int() {
			return self;
		},
		min() {
			return self;
		},
		max() {
			return self;
		},
	};
	return self;
}

function stubPi() {
	const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
	const pi = {
		zod: {
			object: () => ({}),
			string: () => chain(),
			number: () => chain(),
		},
		registerTool(def: { name: string; execute: (...args: never[]) => Promise<unknown> }) {
			tools.set(def.name, def);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, tools };
}

describe("memory_consolidate", () => {
	test("POSTs /agentmemory/consolidate-pipeline with tier", async () => {
		const seen: { url: string; method: string; body: string | null }[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({
				url: String(input),
				method: init?.method || "GET",
				body: typeof init?.body === "string" ? init.body : null,
			});
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as typeof fetch;

		const { pi, tools } = stubPi();
		registerTools(pi, {
			enabled: () => true,
			config: () => ({ url: "http://127.0.0.1:3111", secret: "tok" }),
			project: () => "agentmemory-tailnet",
		});

		const result = await tools.get("memory_consolidate")!.execute(
			"id" as never,
			{ tier: "semantic" } as never,
			undefined as never,
			undefined as never,
			{ cwd: "/tmp" } as never,
		);
		expect(seen[0]?.url).toBe("http://127.0.0.1:3111/agentmemory/consolidate-pipeline");
		expect(seen[0]?.method).toBe("POST");
		expect(JSON.parse(seen[0]!.body!)).toEqual({ tier: "semantic" });
		expect(result).toMatchObject({ details: { ok: true } });
	});
});
