import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, openDatabase } from "../../../src/core/features/storage";
import {
	executeContextRecomp,
	runCompartmentAgent,
} from "../../../src/core/hooks/compartment-runner";
import { resolveWrapupProtectedTailBoundary } from "../../../src/core/hooks/protected-tail-boundary";
import { setRawMessageProvider } from "../../../src/core/hooks/read-session-chunk";
import * as shared from "../../../src/core/shared";
import type { PluginContext } from "../../../src/plugin/types";

const tempDirs: string[] = [];
const rawProviderCleanups: Array<() => void> = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
	closeDatabase();
	for (const cleanup of rawProviderCleanups.splice(0)) cleanup();
	process.env.XDG_DATA_HOME = originalXdgDataHome;

	for (const dir of tempDirs) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch {
			// Ignore EBUSY on Windows
		}
	}
	tempDirs.length = 0;
});

describe("historian timeout wiring", () => {
	it("passes historianTimeoutMs to incremental historian runs", async () => {
		useTempDataHome("magic-context-incremental-timeout-");
		setRawSessionProvider("ses-incremental-timeout", [
			{ id: "m-1", role: "user", text: "eligible one" },
			{ id: "m-2", role: "assistant", text: "eligible two" },
			{ id: "m-3", role: "user", text: "protected 1" },
			{ id: "m-4", role: "user", text: "protected 2" },
			{ id: "m-5", role: "user", text: "protected 3" },
			{ id: "m-6", role: "user", text: "protected 4" },
			{ id: "m-7", role: "user", text: "protected 5" },
		]);

		const db = openDatabase();
		const client = createHistorianClient(
			"/tmp/incremental-timeout",
			`<compartment start="1" end="2" title="Eligible history"><p1>Summary</p1></compartment>`,
		);
		const promptSyncSpy = vi
			.spyOn(shared, "promptSyncWithModelSuggestionRetry")
			.mockResolvedValue(undefined);

		try {
			await runCompartmentAgent({
				client,
				db,
				sessionId: "ses-incremental-timeout",
				historianChunkTokens: 10_000,
				historianTimeoutMs: 456_789,
				boundarySnapshot: makeBoundarySnapshot(db, "ses-incremental-timeout"),
				currentContextLimit: 20,
				directory: "/tmp",
			});

			expect(promptSyncSpy).toHaveBeenCalledTimes(1);
			// toMatchObject (partial) instead of toEqual (exact) because the prompt-sync
			// helper now also receives fallbackModels + callContext for v0.18 fallback
			// chain support; this test only asserts the historian timeout reaches it.
			expect(promptSyncSpy.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 456_789 });
		} finally {
			promptSyncSpy.mockRestore();
		}
	});

	it("passes historianTimeoutMs to recomp historian runs", async () => {
		useTempDataHome("magic-context-recomp-timeout-");
		setRawSessionProvider("ses-recomp-timeout-wiring", [
			{ id: "m-1", role: "user", text: "eligible one" },
			{ id: "m-2", role: "assistant", text: "eligible two" },
			{ id: "m-3", role: "user", text: "eligible three" },
			{ id: "m-4", role: "assistant", text: "eligible four" },
			{ id: "m-5", role: "user", text: "protected 1" },
			{ id: "m-6", role: "user", text: "protected 2" },
			{ id: "m-7", role: "user", text: "protected 3" },
			{ id: "m-8", role: "user", text: "protected 4" },
			{ id: "m-9", role: "user", text: "protected 5" },
		]);

		const db = openDatabase();
		const client = createHistorianClient(
			"/tmp/recomp-timeout",
			`<compartment start="1" end="4" title="Recovered history"><p1>Summary</p1></compartment>`,
		);
		const promptSyncSpy = vi
			.spyOn(shared, "promptSyncWithModelSuggestionRetry")
			.mockResolvedValue(undefined);

		try {
			await executeContextRecomp({
				client,
				db,
				sessionId: "ses-recomp-timeout-wiring",
				historianChunkTokens: 10_000,
				historianTimeoutMs: 456_789,
				boundarySnapshot: makeBoundarySnapshot(db, "ses-recomp-timeout-wiring"),
				currentContextLimit: 20,
				directory: "/tmp",
			});

			expect(promptSyncSpy).toHaveBeenCalledTimes(1);
			// toMatchObject (partial) — see note in incremental test above.
			expect(promptSyncSpy.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 456_789 });
		} finally {
			promptSyncSpy.mockRestore();
		}
	});
});

function makeBoundarySnapshot(db: ReturnType<typeof openDatabase>, sessionId: string) {
	return resolveWrapupProtectedTailBoundary({
		db,
		sessionId,
		mode: "manual-wrapup",
		contextLimit: 20,
		executeThresholdPercentage: 50,
		usage: { percentage: 0, inputTokens: 0 },
		usageSource: "live",
		providerShapeVersion: "pi-folded-v1",
		cacheNamespace: "test",
		messagesToKeep: 5,
	}).snapshot;
}

function createHistorianClient(directory: string, output: string): PluginContext["client"] {
	return {
		session: {
			get: vi.fn(async () => ({ data: { directory } })),
			create: vi.fn(async () => ({ data: { id: "ses-historian-child" } })),
			prompt: vi.fn(async () => ({})),
			messages: vi.fn(async () => ({
				data: [
					{
						info: { role: "assistant", time: { created: 1 } },
						parts: [{ type: "text", text: output }],
					},
				],
			})),
			delete: vi.fn(async () => ({})),
		},
	} as unknown as PluginContext["client"];
}

function useTempDataHome(prefix: string): void {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	process.env.XDG_DATA_HOME = dir;
}

function setRawSessionProvider(
	sessionId: string,
	messages: Array<{ id: string; role: "user" | "assistant"; text: string }>,
): void {
	rawProviderCleanups.push(
		setRawMessageProvider(sessionId, {
			readMessages: () =>
				messages.map((message, index) => ({
					ordinal: index + 1,
					id: message.id,
					role: message.role,
					parts: [{ type: "text", text: message.text }],
					version: null,
				})),
			getStoredMessageCount: () => messages.length,
		}),
	);
}
