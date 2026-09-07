import { describe, expect, it } from "vitest";
import { AgentMemoryClient, decodeAgentMemorySearchResults } from "../../src/agentmemory/client";

describe("agentmemory public REST contract", () => {
	it("uses the existing health, session, search, and remember endpoint shapes", async () => {
		const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
		const client = new AgentMemoryClient(
			{ url: "http://127.0.0.1:3111" },
			{
				fetch: async (url, init) => {
					const body =
						typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
					requests.push({ path: new URL(url).pathname, method: init?.method ?? "GET", ...(body ? { body } : {}) });
					const response = requests.at(-1)?.path.endsWith("/health")
						? { status: "ok" }
						: requests.at(-1)?.path.endsWith("/session/start")
							? { sessionId: "remote-1" }
							: requests.at(-1)?.path.endsWith("/search")
								? {
										results: [
											{
												observation: { id: "o1", narrative: "fact", project: "repo" },
												score: 0.8,
												sessionId: "remote-1",
											},
										],
									}
								: { success: true, memory: { id: "m1" } };
					return new Response(JSON.stringify(response), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
			},
		);
		await client.health();
		await client.startSession({ sessionId: "omp-1", project: "repo", cwd: "/repo" });
		await client.observe({
			sessionId: "remote-1",
			project: "repo",
			hookType: "prompt_submit",
			data: { prompt: "fact" },
		});
		const search = await client.search({ query: "fact", project: "repo", limit: 2 });
		await client.remember({ content: "fact", project: "repo" });
		expect(requests.map(request => `${request.method} ${request.path}`)).toEqual([
			"GET /agentmemory/health",
			"POST /agentmemory/session/start",
			"POST /agentmemory/observe",
			"POST /agentmemory/search",
			"POST /agentmemory/remember",
		]);
		expect(requests[1]?.body).toMatchObject({ sessionId: "omp-1", project: "repo", cwd: "/repo" });
		expect(requests[2]?.body).toMatchObject({
			sessionId: "remote-1",
			hookType: "prompt_submit",
			timestamp: expect.any(String),
		});
		expect(requests[3]?.body).toMatchObject({ query: "fact", project: "repo", format: "full" });
		expect(decodeAgentMemorySearchResults(search)).toEqual([
			{
				id: "o1",
				content: "fact",
				kind: "observation",
				project: "repo",
				agentId: undefined,
				sessionId: "remote-1",
				score: 0.8,
			},
		]);
	});
});
