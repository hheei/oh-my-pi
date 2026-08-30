import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai.ts";

describe("OpenAICompatibleEmbeddingProvider classified failures", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test.each([
		{
			name: "router namespace rewrite is a substitution rejection",
			model: "baai/bge-m3-embedding",
			response: new Response(JSON.stringify({ model: "bge-m3", data: [{ embedding: [0.1, 0.2] }] }), {
				status: 200,
			}),
			failureClass: "substitution_rejected",
			reason:
				"served model 'bge-m3' does not match requested 'baai/bge-m3-embedding' (substitution guard)",
		},
		{
			name: "HTTP failure includes a redacted body excerpt",
			model: "test-model",
			response: new Response(
				'{"error":"quota exhausted","api_key":"sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"}',
				{ status: 402 },
			),
			failureClass: "http_error",
			reason: 'HTTP 402 from endpoint: {"error":"quota exhausted","api_key":"<REDACTED:api_key>"}',
		},
		{
			name: "empty data is a genuine empty result",
			model: "test-model",
			response: new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }),
			failureClass: "empty_result",
			reason: "response data[] was empty",
		},
		{
			name: "wrong envelope reports the available keys",
			model: "test-model",
			response: new Response(JSON.stringify({ object: "list", results: [] }), {
				status: 200,
			}),
			failureClass: "invalid_envelope",
			reason: "response had keys [object, results] but data[] was absent",
		},
	])("$name", async ({ model, response, failureClass, reason }) => {
		globalThis.fetch = (async () => response) as unknown as typeof fetch;
		const provider = new OpenAICompatibleEmbeddingProvider({
			endpoint: "http://127.0.0.1:65535",
			model,
		});

		expect(await provider.embed("text")).toBeNull();
		expect(provider.getLastFailureReason()).toEqual({
			class: failureClass,
			reason,
			retryable: failureClass === "empty_result",
		});
	});

	function makeProvider(model = "test-model"): OpenAICompatibleEmbeddingProvider {
		return new OpenAICompatibleEmbeddingProvider({
			endpoint: "http://127.0.0.1:65535",
			model,
		});
	}

	test("mixed data[] keeps vectors for complete items and classifies the rest", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					object: "list",
					model: "test-model",
					data: [{ embedding: [0.1, 0.2] }, { object: "embedding" }],
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const p = makeProvider();
		const results = await p.embedBatch(["kept", "missing"]);
		expect(results[0]).toEqual(new Float32Array([0.1, 0.2]));
		expect(results[1]).toBeNull();
		expect(p.getLastFailureReason()).toEqual({
			class: "invalid_envelope",
			reason:
				"response had keys [data, model, object] but data[].embedding was absent for some inputs",
			retryable: true,
		});
	});

	test("a complete data[] response clears lastFailureReason", async () => {
		const p = makeProvider();
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					object: "list",
					model: "test-model",
					data: [{ embedding: [0.1, 0.2] }, { object: "embedding" }],
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		await p.embedBatch(["kept", "missing"]);
		expect(p.getLastFailureReason()?.class).toBe("invalid_envelope");

		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					object: "list",
					model: "test-model",
					data: [{ embedding: [0.3, 0.4] }, { embedding: [0.5, 0.6] }],
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const results = await p.embedBatch(["a", "b"]);
		expect(results[0]).toEqual(new Float32Array([0.3, 0.4]));
		expect(results[1]).toEqual(new Float32Array([0.5, 0.6]));
		expect(p.getLastFailureReason()).toBeNull();
	});
});
