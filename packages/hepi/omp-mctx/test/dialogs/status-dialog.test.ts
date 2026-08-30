import { describe, expect, it } from "vitest";
import { resolveProjectIdentity } from "#core/features/memory/project-identity";
import { updateSessionMeta } from "#core/features/storage-meta";
import { setSessionWorkMetrics } from "#core/features/storage-meta-persisted";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { buildPiStatusDetail, showStatusDialog } from "../../src/dialogs/status-dialog";
import { createTestDb, fakeContext } from "../test-utils.test";

describe("Pi status dialog", () => {
	it("displays usage against the output-reserved safe window", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-reserved-window";
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 50_000,
					percent: 50,
					contextWindow: 100_000,
				}),
				getSystemPrompt: () => "system prompt",
			};

			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
				sessionId,
			);
			expect(detail.contextLimit).toBe(80_000);
			expect(detail.usagePercentage).toBe(62.5);
		} finally {
			closeQuietly(db);
		}
	});

	it("hides stale token attribution after resume", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-resume-stale-attribution";
			updateSessionMeta(db, sessionId, { toolCallTokens: 415_500 });
			const rendered: string[][] = [];
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 32_000,
					percent: 40,
					contextWindow: 100_000,
				}),
				getSystemPrompt: () => "system prompt",
				ui: {
					async custom(factory: unknown) {
						const makeComponent = factory as (
							tui: { requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ requestRender: () => undefined },
							{ fg: (_name, text) => text, bold: (text) => text },
							undefined,
							() => undefined,
						);
						rendered.push(component.render(100));
						component.dispose?.();
						return undefined;
					},
				},
			};

			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, {
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
			});

			const text = rendered.flat().join("\n");
			expect(text).toContain("Context  40.0%");
			expect(text).not.toContain("Tool Calls");
			expect(text).not.toContain("█");
		} finally {
			closeQuietly(db);
		}
	});
	it("renders stored work metrics", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-work";
			setSessionWorkMetrics(db, sessionId, 1200, 9800);
			const rendered: string[][] = [];
			const ctx = {
				...fakeContext(sessionId),
				ui: {
					async custom(factory: unknown) {
						const makeComponent = factory as (
							tui: { requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ requestRender: () => undefined },
							{ fg: (_name, text) => text, bold: (text) => text },
							undefined,
							() => undefined,
						);
						rendered.push(component.render(100));
						component.dispose?.();
						return undefined;
					},
				},
				getSystemPrompt: () => "",
			};

			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, {
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
			});

			const text = rendered.flat().join("\n");
			expect(text).toContain("Work tokens 1.2K new · 9.8K total input");
			expect(text).not.toContain("Tool Calls");
			expect(text).not.toContain("System");
			expect(text).not.toContain("█");
		} finally {
			closeQuietly(db);
		}
	});

	it("floors a new session at system prompt + tool definitions", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-prefix";
			const systemPrompt =
				"You are pi.\n\n<available_skills>\n  <skill><name>tdd</name></skill>\n</available_skills>";
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 0,
					percent: 0,
					contextWindow: 100_000,
				}),
				getSystemPrompt: () => systemPrompt,
			};

			const detail = buildPiStatusDetail(
				{
					getAllTools: () => [
						{
							name: "read",
							description: "Read a file",
							parameters: {
								type: "object",
								properties: { path: { type: "string" } },
							},
						},
					],
				} as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
				sessionId,
			);
			expect(detail.systemPromptTokens).toBeGreaterThan(0);
			expect(detail.toolDefinitionTokens).toBeGreaterThan(0);
			expect(detail.inputTokens).toBe(detail.systemPromptTokens + detail.toolDefinitionTokens);
			expect(detail.tokenBreakdownAvailable).toBe(true);
			expect(detail.usagePercentage).toBeGreaterThan(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("renders System and Tool Defs into the visible /ctx-status total", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-prefix-render";
			const systemPrompt =
				"You are pi.\n\n<available_skills>\n  <skill><name>tdd</name></skill>\n</available_skills>";
			const rendered: string[][] = [];
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 0,
					percent: 0,
					contextWindow: 100_000,
				}),
				getSystemPrompt: () => systemPrompt,
				ui: {
					async custom(factory: unknown) {
						const makeComponent = factory as (
							tui: { requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ requestRender: () => undefined },
							{ fg: (_name, text) => text, bold: (text) => text },
							undefined,
							() => undefined,
						);
						rendered.push(component.render(100));
						component.dispose?.();
						return undefined;
					},
				},
			};

			await showStatusDialog(
				{
					getAllTools: () => [
						{
							name: "read",
							description: "Read a file",
							parameters: {
								type: "object",
								properties: { path: { type: "string" } },
							},
						},
					],
				} as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
			);

			const text = rendered.flat().join("\n");
			expect(text).toContain("System");
			expect(text).toContain("Tool Defs");
			expect(text).toContain("█");
			expect(text).not.toMatch(/Context\s+[\d.]+%\s+·\s+0\s+\//);
		} finally {
			closeQuietly(db);
		}
	});
});
