import { describe, expect, it } from "vitest";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { registerMagicContextTools } from "../../src/tools/index";
import { createTestDb } from "../test-utils.test";

describe("registerMagicContextTools", () => {
	it("can omit ctx_memory for retrieval-only sidekick subagents", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => {
					registered.push(tool.name);
				},
				registerCommand: (name: string) => {
					commands.push(name);
				},
			} as never;

			registerMagicContextTools(pi, {
				db,
				memoryToolEnabled: false,
				sessionScopedToolsDisabled: true,
			});

			expect(registered).toContain("ctx_search");
			expect(registered).not.toContain("ctx_memory");
			expect(registered).not.toContain("ctx_note");
			expect(registered).not.toContain("ctx_expand");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it("removes only ctx_reduce in compaction-off mode", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: () => undefined,
			} as never;
			registerMagicContextTools(pi, { db, compactionOff: true });

			expect(registered).not.toContain("ctx_reduce");
			expect(registered).toEqual(
				expect.arrayContaining(["ctx_search", "ctx_memory", "ctx_note", "ctx_expand"]),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("advertises only real ctx_* fields and allows additional properties", () => {
		const db = createTestDb();
		try {
			const registered = new Map<
				string,
				{
					name: string;
					parameters: {
						properties?: Record<string, unknown>;
						additionalProperties?: unknown;
					};
				}
			>();
			const pi = {
				registerTool: (tool: {
					name: string;
					parameters: {
						properties?: Record<string, unknown>;
						additionalProperties?: unknown;
					};
				}) => registered.set(tool.name, tool),
				registerCommand: () => undefined,
			} as never;

			registerMagicContextTools(pi, { db });

			const expectedFields: Record<string, string[]> = {
				ctx_search: ["query", "limit", "sources"],
				ctx_memory: ["action", "content", "category", "ids", "limit", "reason"],
				ctx_note: [
					"action",
					"content",
					"surface_condition",
					"note_id",
					"filter",
					"limit",
					"offset",
				],
				ctx_expand: ["start", "end", "verbose", "message"],
				ctx_reduce: ["drop"],
			};
			for (const [name, fields] of Object.entries(expectedFields)) {
				const definition = registered.get(name);
				expect(definition).toBeDefined();
				expect(Object.keys(definition?.parameters.properties ?? {}).sort()).toEqual(
					[...fields].sort(),
				);
				expect(definition?.parameters.properties).not.toHaveProperty("reduced");
				expect(definition?.parameters.properties).not.toHaveProperty("summary");
				expect(definition?.parameters.additionalProperties).toBe(true);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("frames registered tools with the shared ToolTui", () => {
		const db = createTestDb();
		try {
			const registered: Array<{
				name: string;
				renderShell?: string;
				renderCall?: (...args: never[]) => { render: (width: number) => string[] };
				renderResult?: (...args: never[]) => { render: (width: number) => string[] };
			}> = [];
			const pi = {
				registerTool: (tool: (typeof registered)[number]) => {
					registered.push(tool);
				},
				registerCommand: () => undefined,
				on: () => undefined,
			} as never;
			registerMagicContextTools(pi, { db });

			const search = registered.find((tool) => tool.name === "ctx_search");
			expect(search?.renderShell).toBe("self");
			const theme = {
				bg: (_role: string, text: string): string => text,
				fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
				bold: (text: string): string => text,
			};
			const context = {
				args: { query: "token usage" },
				toolCallId: "search-1",
				invalidate: (): void => undefined,
				state: {},
				cwd: "/tmp",
				executionStarted: true,
				argsComplete: true,
				showImages: false,
				expanded: false,
				lastComponent: undefined,
				isPartial: false,
				isError: false,
			};
			const header = search
				?.renderCall?.(context.args as never, theme as never, context as never)
				.render(80)
				.join("\n");
			expect(header).toContain("Magic Context: Search");
			expect(header).toContain("token usage");
			const body = search
				?.renderResult?.(
					{
						content: [{ type: "text", text: "[1] [memory] id=1" }],
						details: undefined,
					} as never,
					{ isPartial: false, expanded: false } as never,
					theme as never,
					context as never,
				)
				.render(80);
			expect(body?.some((line) => line.includes("[1] [memory] id=1"))).toBe(true);
			expect(body?.some((line) => line.includes("─"))).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("registered tools resolve smart-note gating from the invocation cwd", async () => {
		const db = createTestDb();
		try {
			const registered = new Map<string, { execute: (...args: never[]) => unknown }>();
			const pi = {
				registerTool: (tool: { name: string; execute: (...args: never[]) => unknown }) => {
					registered.set(tool.name, tool);
				},
				registerCommand: () => undefined,
			} as never;

			registerMagicContextTools(pi, {
				db,
				dreamerEnabled: false,
				resolveDreamerEnabled: (ctx) => ctx.cwd === "/tmp/project-b",
			});

			const noteTool = registered.get("ctx_note");
			expect(noteTool).toBeDefined();
			const result = await noteTool?.execute(
				"call-1" as never,
				{
					action: "write",
					content: "Project B smart note",
					surface_condition: "When project B condition is true",
				} as never,
				new AbortController().signal as never,
				undefined as never,
				{
					cwd: "/tmp/project-b",
					sessionManager: { getSessionId: () => "ses-tool-cd" },
				} as never,
			);

			expect((result as { isError?: boolean } | undefined)?.isError).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});
});
