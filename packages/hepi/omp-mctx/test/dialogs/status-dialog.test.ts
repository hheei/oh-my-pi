import { describe, expect, it } from "vitest";
import { resolveProjectIdentity } from "#core/features/memory/project-identity";
import { updateSessionMeta } from "#core/features/storage-meta";
import {
	incrementHistorianFailure,
	recordHistorianDrainFailure,
	setSessionWorkMetrics,
} from "#core/features/storage-meta-persisted";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { admitRecallEvent, ensureRecallLedgerSchema, recordProjectionEpoch } from "../../src/agentmemory/recall-ledger";
import { recordHistorianRun } from "#core/features/storage-historian-runs";
import {
	buildStatusSections,
	collectStatusSnapshot,
	renderStatusMarkdown,
	showStatusDialog,
} from "../../src/dialogs/status-dialog";
import { createTestDb, fakeContext } from "../test-utils.test";

describe("Pi status dialog", () => {
	it("uses the kernel context window and percentage", () => {
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

			const detail = collectStatusSnapshot(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
				sessionId,
			);
			expect(detail.contextLimit).toBe(100_000);
			expect(detail.usagePercentage).toBe(50);
			expect(detail.historianLatestSuccess).toBeNull();
			const markdown = renderStatusMarkdown(buildStatusSections(detail));
			expect(markdown).toContain("**Kernel usage:** 50K / 100K tokens (50.0%)");
			expect(markdown).not.toMatch(/dreamer/i);
			expect(markdown).toContain(`**Session:** ${sessionId}`);
			expect(buildStatusSections(detail).map((section) => section.title)).toEqual([
				"Summary",
				"Context",
				"Memory",
				"Background Work",
				"Diagnostics",
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("distinguishes Historian running, backing off, and latest success", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-historian-activity";
			recordHistorianRun(db, {
				sessionId,
				harness: "pi",
				runKind: "incremental",
				status: "success",
				compartmentsProduced: 2,
			});
			updateSessionMeta(db, sessionId, { compartmentInProgress: true });
			const deps = { db, projectIdentity: resolveProjectIdentity(process.cwd()) };
			const running = collectStatusSnapshot(
				{ getAllTools: () => [] } as never,
				fakeContext(sessionId) as never,
				deps,
				sessionId,
			);
			const runningBackground = buildStatusSections(running).find((section) => section.title === "Background Work");
			expect(running.historianRunning).toBe(true);
			expect(running.historianLatestSuccess?.compartmentsProduced).toBe(2);
			expect(runningBackground?.items).toEqual(
				expect.arrayContaining([expect.objectContaining({ label: "Historian", value: "running" })]),
			);

			updateSessionMeta(db, sessionId, { compartmentInProgress: false });
			incrementHistorianFailure(db, sessionId, "provider unavailable");
			recordHistorianDrainFailure(db, sessionId);
			const failed = collectStatusSnapshot(
				{ getAllTools: () => [] } as never,
				fakeContext(sessionId) as never,
				deps,
				sessionId,
			);
			const failedMarkdown = renderStatusMarkdown(buildStatusSections(failed));
			expect(failed.historianRunning).toBe(false);
			expect(failed.historianFailureCount).toBe(1);
			expect(failedMarkdown).toContain("**Historian:** backing off (1)");
			expect(failedMarkdown).toContain("**Last successful run:**");
		} finally {
			closeQuietly(db);
		}
	});

	it("renders typed recomp progress and maintenance actions", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-actions";
			db.prepare("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, ?, ?)").run(
				sessionId,
				1,
				"drop",
				Date.now(),
			);
			const progress = {
				sessionId,
				kind: "upgrade" as const,
				phase: "recomp" as const,
				processedMessages: 3,
				totalMessages: 10,
				passCount: 1,
				compartmentsCreated: 2,
				startedAt: Date.now() - 5_000,
				updatedAt: Date.now() - 1_000,
				note: "Running historian",
			};
			const snapshot = collectStatusSnapshot(
				{ getAllTools: () => [] } as never,
				fakeContext(sessionId) as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
					recompProgressBySession: new Map([[sessionId, progress]]),
				},
				sessionId,
			);
			const markdown = renderStatusMarkdown(
				buildStatusSections({ ...snapshot, upgradeNeededCount: 2 }),
			);
			expect(snapshot.recompInFlight).toBe(true);
			expect(markdown).toContain("3/10 messages (30%)");
			expect(markdown).toContain("Running historian");
			const healthMarkdown = renderStatusMarkdown(
				buildStatusSections({
					...snapshot,
					agentMemory: {
						...snapshot.agentMemory,
						gates: { ...snapshot.agentMemory.gates, bridge: true },
						observed: { ...snapshot.agentMemory.observed, availability: "unknown" },
					},
				}),
			);
			expect(healthMarkdown).toContain("/agentmemory-health");
			expect(markdown).toContain("run /ctx-flush");
			expect(markdown).toContain("run /ctx-session-upgrade");
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

	it("keeps kernel usage authoritative when prefix attribution is available", () => {
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

			const detail = collectStatusSnapshot(
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
			expect(detail.inputTokens).toBe(0);
			expect(detail.tokenBreakdownAvailable).toBe(false);
			expect(detail.usagePercentage).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("does not render prefix attribution beyond the kernel total", async () => {
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

			expect(text).not.toContain("System");
			expect(text).not.toContain("Tool Defs");
			expect(text).not.toContain("█");
			expect(text).toMatch(/Context\s+0\.0%\s+·\s+0\s+\//);
		} finally {
			closeQuietly(db);
		}
	});
	it("shows explicit residual and Recall attribution against kernel usage", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-recall-residual";
			updateSessionMeta(db, sessionId, {
				conversationTokens: 60,
				toolCallTokens: 10,
				recallTokens: 5,
				tokenAttributionRevision: "post-projection-revision",
				tokenAttributionModelKey: "anthropic/claude",
				tokenAttributionUpdatedAt: 1,
			});
			const snapshot = collectStatusSnapshot(
				{ getAllTools: () => [] } as never,
				{
					...fakeContext(sessionId),
					model: { provider: "anthropic", id: "claude", contextWindow: 1_000, maxTokens: 1 },
					getContextUsage: () => ({ tokens: 100, percent: 10, contextWindow: 1_000 }),
					getSystemPrompt: () => "",
				} as never,
				{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
				sessionId,
			);
			expect(snapshot.tokenBreakdownAvailable).toBe(true);
			expect(snapshot.recallTokens).toBe(5);
			expect(snapshot.unattributedTokens).toBe(25);
			expect(renderStatusMarkdown(buildStatusSections(snapshot))).toContain(
				"**Unattributed/Framing:** 25 tokens",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses bounded legacy attribution before revision stamps existed", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-legacy-attribution";
			updateSessionMeta(db, sessionId, {
				conversationTokens: 60,
				toolCallTokens: 10,
				recallTokens: 5,
			});
			const snapshot = collectStatusSnapshot(
				{ getAllTools: () => [] } as never,
				{
					...fakeContext(sessionId),
					model: { provider: "anthropic", id: "claude", contextWindow: 1_000, maxTokens: 1 },
					getContextUsage: () => ({ tokens: 100, percent: 10, contextWindow: 1_000 }),
					getSystemPrompt: () => "",
				} as never,
				{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
				sessionId,
			);
			expect(snapshot.tokenBreakdownAvailable).toBe(true);
			expect(snapshot.unattributedTokens).toBe(25);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps kernel summary while an overrun attribution awaits refresh", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-refresh-pending";
			updateSessionMeta(db, sessionId, {
				conversationTokens: 101,
				tokenAttributionRevision: "post-projection-revision",
				tokenAttributionModelKey: "anthropic/claude",
				tokenAttributionUpdatedAt: 1,
			});
			const snapshot = collectStatusSnapshot(
				{ getAllTools: () => [] } as never,
				{
					...fakeContext(sessionId),
					model: { provider: "anthropic", id: "claude", contextWindow: 1_000, maxTokens: 1 },
					getContextUsage: () => ({ tokens: 100, percent: 10, contextWindow: 1_000 }),
					getSystemPrompt: () => "",
				} as never,
				{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
				sessionId,
			);
			expect(snapshot.inputTokens).toBe(100);
			expect(snapshot.tokenBreakdownAvailable).toBe(false);
			expect(snapshot.tokenBreakdownRefreshPending).toBe(true);
			expect(renderStatusMarkdown(buildStatusSections(snapshot))).toContain(
				"**Attribution:** refresh pending",
			);
		} finally {
			closeQuietly(db);
		}
	});
	it("renders committed active-recall previews in TUI and headless Markdown", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-agentmemory-recall";
			ensureRecallLedgerSchema(db);
			recordProjectionEpoch(db, {
				epochId: "epoch-main",
				sessionId,
				branchId: "main",
				reason: "upgrade",
				rendererVersion: "test",
				contractDigest: "contract",
				snapshotDigest: "snapshot",
			});
			admitRecallEvent(db, {
				sessionId,
				branchId: "main",
				epochId: "epoch-main",
				userEntryAnchor: "user-1",
				body: new TextEncoder().encode("visible\trecall /home/chlo/project"),
				origin: "direct_retrieval",
				promotionEligibility: "requires_independent_evidence",
				sources: [{ sourceId: "memory-1", sourceKind: "memory", contentDigest: "digest", project: "project", scope: { project: "project" } }],
				dependencies: [],
			});
			admitRecallEvent(db, {
				sessionId,
				branchId: "main",
				epochId: "epoch-main",
				userEntryAnchor: "user-2",
				body: new TextEncoder().encode("later recall"),
				origin: "direct_retrieval",
				promotionEligibility: "requires_independent_evidence",
				sources: [{ sourceId: "memory-2", sourceKind: "memory", contentDigest: "digest-2", project: "project", scope: { project: "project" } }],
				dependencies: [],
			});
			const rendered: string[][] = [];
			let closed = 0;
			const ctx = {
				...fakeContext(sessionId),
				getSystemPrompt: () => "",
				ui: {
					async custom(factory: unknown) {
						const component = (factory as (tui: { requestRender: () => void }, theme: { fg: (_name: string, text: string) => string; bold: (text: string) => string }, keybindings: unknown, done: (value: undefined) => void) => { render: (width: number) => string[]; handleInput: (data: string) => void; dispose?: () => void })({ requestRender: () => undefined }, { fg: (_name, text) => text, bold: text => text }, undefined, () => { closed += 1; });
						rendered.push(component.render(100));
						component.handleInput("\t");
						component.handleInput("\t");
						rendered.push(component.render(32));
						expect(rendered[rendered.length - 1]?.join("\n")).toContain("Memory");
						expect(rendered[rendered.length - 1]?.join("\n")).toContain("visible");
						component.handleInput("j");
						rendered.push(component.render(32));
						expect(rendered[rendered.length - 1]?.join("\n")).toContain("Recall 2");
						component.handleInput("\r");
						expect(closed).toBe(1);
						component.dispose?.();
						return undefined;
					},
				},
			};
			const deps = { db, projectIdentity: resolveProjectIdentity(process.cwd()) };
			const snapshot = collectStatusSnapshot({ getAllTools: () => [] } as never, ctx as never, deps, sessionId);
			expect(renderStatusMarkdown(buildStatusSections(snapshot))).toContain("visible");
			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, deps, snapshot);
			expect(rendered.flat().join("\n")).toContain("visible");
		} finally {
			closeQuietly(db);
		}
	});
});
