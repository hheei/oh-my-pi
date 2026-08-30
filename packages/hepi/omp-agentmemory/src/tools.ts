import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { request, type AgentmemoryConfig } from "./client.ts";
import { formatSearchResults, type SmartSearchResult } from "./format.ts";
import { jsonText } from "./text.ts";

export type ToolRuntime = {
	enabled: () => boolean;
	config: () => AgentmemoryConfig;
	project: (cwd: string) => string;
};
type ToolOut = { content: { type: "text"; text: string }[]; details: { ok: boolean } };

function disabled(): ToolOut {
	return {
		content: [{ type: "text", text: "omp-agentmemory is disabled (plugin setting enabled=false)." }],
		details: { ok: false },
	};
}

async function restResult(
	pathname: string,
	config: AgentmemoryConfig,
	options?: { method?: "GET" | "POST"; body?: unknown },
): Promise<ToolOut> {
	const payload = await request<unknown>(pathname, config, options);
	if (payload === null) {
		return {
			content: [{ type: "text", text: `agentmemory ${pathname} failed.` }],
			details: { ok: false },
		};
	}
	return {
		content: [{ type: "text", text: jsonText(payload) }],
		details: { ok: true },
	};
}

export function registerTools(pi: ExtensionAPI, runtime: ToolRuntime): void {
	const z = pi.zod;

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search Durable Memory for decisions, bugs, preferences, and workflows. Not session Window search.",
		parameters: z.object({
			query: z.string().describe("What to search for"),
			limit: z.number().int().min(1).max(10).optional().describe("Maximum results"),
		}),
		execute: async (_id, raw, _signal, _onUpdate, ctx: ExtensionContext) => {
			if (!runtime.enabled()) return disabled();
			const params = raw as { query: string; limit?: number };
			const result = await request<{ results?: SmartSearchResult[] }>("smart-search", runtime.config(), {
				body: { query: params.query, limit: params.limit ?? 5, project: runtime.project(ctx.cwd) },
			});
			const results = result?.results || [];
			return {
				content: [{ type: "text" as const, text: formatSearchResults(results) }],
				details: { query: params.query, results },
			};
		},
	});

	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description: "Save a durable fact, convention, workflow, preference, or bug fix. Not ctx_note.",
		parameters: z.object({
			content: z.string().describe("What should be remembered"),
			type: z.string().optional().describe("Memory type"),
		}),
		execute: async (_id, raw, _signal, _onUpdate, ctx: ExtensionContext) => {
			if (!runtime.enabled()) return disabled();
			const params = raw as { content: string; type?: string };
			const type = params.type || "fact";
			const result = await request<Record<string, unknown>>("remember", runtime.config(), {
				body: { content: params.content, type, project: runtime.project(ctx.cwd) },
			});
			if (!result) {
				return {
					content: [{ type: "text" as const, text: "Failed to save memory." }],
					details: { ok: false },
				};
			}
			return {
				content: [{ type: "text" as const, text: `Saved memory (${type}): ${params.content}` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description: "Search past session observations for relevant context.",
		parameters: z.object({
			query: z.string().describe("Search query"),
			limit: z.number().optional().describe("Max results (default 10)"),
			format: z.string().optional().describe("full, compact, or narrative"),
			token_budget: z.number().optional().describe("Optional token budget"),
		}),
		execute: async (_id, raw) => {
			if (!runtime.enabled()) return disabled();
			const params = raw as { query: string; limit?: number; format?: string; token_budget?: number };
			return restResult("search", runtime.config(), {
				body: {
					query: params.query,
					limit: params.limit ?? 10,
					format: params.format || "full",
					...(params.token_budget !== undefined ? { token_budget: params.token_budget } : {}),
				},
			});
		},
	});

	pi.registerTool({
		name: "memory_sessions",
		label: "Memory Sessions",
		description: "List recent sessions with status and observation counts.",
		parameters: z.object({}),
		execute: async () => {
			if (!runtime.enabled()) return disabled();
			return restResult("sessions", runtime.config(), { method: "GET" });
		},
	});

	pi.registerTool({
		name: "memory_lesson_save",
		label: "Memory Lesson Save",
		description: "Save a lesson learned. Duplicate content strengthens the existing lesson.",
		parameters: z.object({
			content: z.string().describe("The lesson"),
			context: z.string().optional().describe("When this lesson applies"),
			confidence: z.number().optional().describe("0.0-1.0 (default 0.5)"),
			project: z.string().optional().describe("Project this lesson is about"),
			tags: z.string().optional().describe("Comma-separated tags"),
		}),
		execute: async (_id, raw, _signal, _onUpdate, ctx: ExtensionContext) => {
			if (!runtime.enabled()) return disabled();
			const params = raw as {
				content: string;
				context?: string;
				confidence?: number;
				project?: string;
				tags?: string;
			};
			const tags =
				typeof params.tags === "string" && params.tags.trim()
					? params.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
					: undefined;
			return restResult("lessons", runtime.config(), {
				body: {
					content: params.content,
					context: params.context || "",
					...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
					project: params.project || runtime.project(ctx.cwd),
					...(tags ? { tags } : {}),
					source: "manual",
				},
			});
		},
	});

	pi.registerTool({
		name: "memory_consolidate",
		label: "Memory Consolidate",
		description: "Run the 4-tier consolidation pipeline (working -> episodic -> semantic -> procedural).",
		parameters: z.object({
			tier: z.string().optional().describe("Target tier: episodic, semantic, or procedural"),
		}),
		execute: async (_id, raw) => {
			if (!runtime.enabled()) return disabled();
			const params = raw as { tier?: string };
			return restResult("consolidate-pipeline", runtime.config(), {
				body: params.tier ? { tier: params.tier } : {},
			});
		},
	});

	pi.registerTool({
		name: "memory_reflect",
		label: "Memory Reflect",
		description: "Cluster related memories and synthesize higher-order insights.",
		parameters: z.object({
			project: z.string().optional().describe("Filter by project"),
			maxClusters: z.number().optional().describe("Max clusters (default 10, max 20)"),
		}),
		execute: async (_id, raw, _signal, _onUpdate, ctx: ExtensionContext) => {
			if (!runtime.enabled()) return disabled();
			const params = raw as { project?: string; maxClusters?: number };
			return restResult("reflect", runtime.config(), {
				body: {
					project: params.project || runtime.project(ctx.cwd),
					...(params.maxClusters !== undefined ? { maxClusters: params.maxClusters } : {}),
				},
			});
		},
	});

	pi.registerTool({
		name: "memory_diagnose",
		label: "Memory Diagnose",
		description: "Run subsystem health checks (stuck, orphaned, inconsistent state).",
		parameters: z.object({
			categories: z.string().optional().describe("Comma-separated categories (default all)"),
		}),
		execute: async (_id, raw) => {
			if (!runtime.enabled()) return disabled();
			const params = raw as { categories?: string };
			return restResult("diagnostics", runtime.config(), {
				body: params.categories ? { categories: params.categories } : {},
			});
		},
	});
}
