import { describe, expect, it } from "vitest";
import {
	unifiedMemorySearch,
	passesMemorySearchScope,
	createMemorySearchTool,
} from "../../src/agentmemory/memory-search";
import type { AgentMemoryClientPort } from "../../src/agentmemory/client";

function client(overrides: Partial<AgentMemoryClientPort>): AgentMemoryClientPort {
	return overrides as AgentMemoryClientPort;
}

describe("unifiedMemorySearch", () => {
	it("filters mismatched scope and the active capture segment before budgeting", async () => {
		const result = await unifiedMemorySearch(
			async () => [{ id: "w1", content: "window result" }],
			client({
				search: async () => ({
					results: [
						{ id: "ok", content: "durable result", project: "repo", agentId: "a" },
						{ id: "wrong-project", content: "leak", project: "other", agentId: "a" },
						{ id: "active", content: "echo", project: "repo", agentId: "a", sessionId: "current" },
					],
				}),
				searchLessons: async () => ({ lessons: [] }),
			}),
			{ project: "repo", agentId: "a", activeSessionId: "current" },
			"query",
		);
		expect(result.local.map(item => item.id)).toEqual(["w1"]);
		expect(result.remote.map(item => item.id)).toEqual(["ok"]);
	});

	it("keeps incompatible score scales grouped and reports one-lane failure", async () => {
		const result = await unifiedMemorySearch(
			async () => [{ id: "w", content: "local" }],
			client({
				search: async () => {
					throw new Error("offline");
				},
				searchLessons: async () => ({ lessons: [{ id: "l", content: "lesson", project: "repo" }] }),
			}),
			{ project: "repo" },
			"query",
			{ contentBudget: 100 },
		);
		expect(result.local).toHaveLength(1);
		expect(result.remote[0]?.kind).toBe("lesson");
		expect(result.partial.join(" ")).toContain("Durable memory unavailable");
	});

	it("enforces a global content budget while preserving source floors when possible", async () => {
		const result = await unifiedMemorySearch(
			async () => [
				{ id: "w", content: "12345" },
				{ id: "w2", content: "later" },
			],
			client({
				search: async () => ({ results: [{ id: "r", content: "abcde", project: "repo" }] }),
				searchLessons: async () => ({ lessons: [] }),
			}),
			{ project: "repo" },
			"query",
			{ contentBudget: 10, perSourceFloor: 1 },
		);
		expect(result.local).toHaveLength(1);
		expect(result.remote).toHaveLength(1);
		expect(
			[...result.local, ...result.remote].reduce((sum, item) => sum + item.content.length, 0),
		).toBeLessThanOrEqual(10);
	});
});

describe("memory search scope and renderer", () => {
	it("fails closed for unknown project and agent", () => {
		expect(passesMemorySearchScope({ id: "x", content: "x", kind: "memory" }, { project: "repo" })).toBe(false);
		expect(
			passesMemorySearchScope(
				{ id: "x", content: "x", project: "repo", kind: "memory" },
				{ project: "repo", agentId: "a" },
			),
		).toBe(false);
	});

	it("renders labelled groups, partial details, and source identities", async () => {
		const tool = createMemorySearchTool({
			search: async () => ({
				local: [{ id: "l", content: "local" }],
				remote: [{ id: "r", content: "remote", kind: "memory", project: "repo", sessionId: "s", agentId: "a" }],
				partial: ["remote timeout"],
			}),
		});
		const result = await tool.execute(
			"id",
			{ query: "q" },
			new AbortController().signal,
			undefined,
			undefined as never,
		);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Current session");
		expect(text).toContain("Durable memory (agentmemory)");
		expect(text).toContain("Partial results");
		expect(result.details).toEqual({
			local: [{ id: "l" }],
			remote: [
				{
					id: "r",
					kind: "memory",
					project: "repo",
					sessionId: "s",
					agentId: "a",
					contentDigest: "b71199ebd070b36beab7317920c2c2f1d777df8d05e5527d8458fda57cb17a7a",
				},
			],
			partial: ["remote timeout"],
		});
	});
});
