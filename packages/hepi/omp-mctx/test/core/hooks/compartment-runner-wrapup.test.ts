import { describe, expect, it, vi } from "vitest";
import {
	acquireCompartmentLease,
	releaseCompartmentLease,
} from "../../../src/core/features/compartment-lease";
import { getCompartments } from "../../../src/core/features/compartment-storage";
import { resolveProjectIdentity } from "../../../src/core/features/memory/project-identity";
import { getMemoriesByProject } from "../../../src/core/features/memory/storage-memory";
import { initializeDatabase } from "../../../src/core/features/storage-db";

import { reserveProtectedTailDrainTokens } from "../../../src/core/features/storage-meta-persisted";
import { getPrimerCandidatesForProject } from "../../../src/core/features/storage-primers";
import { getUserMemoryCandidates } from "../../../src/core/features/user-memory/storage-user-memory";
import { runCompartmentAgent } from "../../../src/core/hooks/compartment-runner";
import {
	type ProtectedTailBoundarySnapshot,
	resolveWrapupProtectedTailBoundary,
} from "../../../src/core/hooks/protected-tail-boundary";
import {
	readSessionChunk,
	setRawMessageProvider,
} from "../../../src/core/hooks/read-session-chunk";
import { Database } from "../../../src/core/shared/sqlite";
import { closeQuietly } from "../../../src/core/shared/sqlite-helpers";
import type { PluginContext } from "../../../src/plugin/types";

function createDb(): Database {
	const db = new Database(":memory:");
	initializeDatabase(db);
	initializeDatabase(db);
	return db;
}

function rawMessages(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		ordinal: index + 1,
		id: `m-${index + 1}`,
		role: "user",
		parts: [{ type: "text", text: `message ${index + 1} with enough content` }],
	}));
}

function withProviderMessages<T>(
	sessionId: string,
	messages: ReturnType<typeof rawMessages>,
	fn: () => Promise<T>,
): Promise<T> {
	const unregister = setRawMessageProvider(sessionId, {
		readMessages: () => messages,
		getMessageCount: () => messages.length,
	});
	return fn().finally(unregister);
}

function withProvider<T>(sessionId: string, count: number, fn: () => Promise<T>): Promise<T> {
	return withProviderMessages(sessionId, rawMessages(count), fn);
}

function alternatingMessages(count: number) {
	const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
	return Array.from({ length: count }, (_, index) => ({
		ordinal: index + 1,
		id: `m-${index + 1}`,
		role: index % 2 === 0 ? "user" : "assistant",
		parts: [{ type: "text", text: `message ${index + 1} ${text} ${text} ${text}` }],
	}));
}

function historianXml(): string {
	return `<output>
<compartments>
<compartment start="1" end="1" title="Wrapped" episode_type="debug" importance="50">
<p1>Detailed wrapup.</p1><p2>Short wrapup.</p2><p3>Tiny wrapup.</p3><p4>wrapup</p4>
</compartment>
</compartments>
<facts><PROJECT_RULES>
* Keep regression tests around wrapup promotion.
</PROJECT_RULES></facts>
<user_observations>
* User prefers regression tests for wrapup behavior.
</user_observations>
<primer_candidates>
<primer at_compartment="1">How does wrapup promotion work?</primer>
</primer_candidates>
<meta><messages_processed>1-1</messages_processed><unprocessed_from>2</unprocessed_from></meta>
</output>`;
}

function twoCompartmentHistorianXml(): string {
	return `<output>
<compartments>
<compartment start="1" end="2" title="First wrapped" episode_type="debug" importance="50">
<p1>First durable wrapup.</p1><p2>First.</p2><p3>First.</p3><p4>wrapup</p4>
</compartment>
<compartment start="3" end="4" title="Provisional wrapped" episode_type="debug" importance="50">
<p1>Provisional wrapup.</p1><p2>Provisional.</p2><p3>Prov.</p3><p4>wrapup</p4>
</compartment>
</compartments>
<facts><PROJECT_RULES>
* Mid-loop wrapup facts must promote.
</PROJECT_RULES></facts>
<meta><messages_processed>1-4</messages_processed><unprocessed_from>5</unprocessed_from></meta>
</output>`;
}

function client(output = historianXml()): PluginContext["client"] {
	return {
		session: {
			get: vi.fn(async () => ({ data: { directory: "/tmp/wrapup-runner" } })),
			create: vi.fn(async () => ({ data: { id: `child-${Math.random()}` } })),
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

function wrapupSnapshot(
	db: Database,
	sessionId: string,
	usagePercentage = 0,
): ProtectedTailBoundarySnapshot {
	return resolveWrapupProtectedTailBoundary({
		db,
		sessionId,
		mode: "manual-wrapup",
		contextLimit: 20,
		executeThresholdPercentage: 50,
		usage: { percentage: usagePercentage, inputTokens: 0 },
		usageSource: "live",
		providerShapeVersion: "pi-folded-v1",
		cacheNamespace: "test",
		messagesToKeep: 1,
	}).snapshot;
}

async function runWithLease(args: {
	db: Database;
	sessionId: string;
	snapshot: ProtectedTailBoundarySnapshot;
	forceKeepLastCompartment?: boolean;
	forceDrainQuota?: boolean;
	refreshBoundarySnapshot?: Parameters<typeof runCompartmentAgent>[0]["refreshBoundarySnapshot"];
	historianChunkTokens?: number;
	output?: string;
}) {
	const holderId = `holder-${Math.random()}`;
	expect(acquireCompartmentLease(args.db, args.sessionId, holderId)).not.toBeNull();
	try {
		await runCompartmentAgent({
			client: client(args.output),
			db: args.db,
			sessionId: args.sessionId,
			historianChunkTokens: args.historianChunkTokens ?? 10_000,
			historianTimeoutMs: 5_000,
			boundarySnapshot: args.snapshot,
			currentContextLimit: 20,
			directory: "/tmp/wrapup-runner",
			memoryEnabled: true,
			autoPromote: true,
			experimentalUserMemories: true,
			fallbackModels: [],
			compartmentLeaseHolderId: holderId,
			forceKeepLastCompartment: args.forceKeepLastCompartment,
			forceDrainQuota: args.forceDrainQuota,
			refreshBoundarySnapshot: args.refreshBoundarySnapshot,
		});
	} finally {
		releaseCompartmentLease(args.db, args.sessionId, holderId);
	}
}

describe("runCompartmentAgent wrapup controls", () => {
	it("persists a forced final compartment but skips facts, user observations, and primers", async () => {
		const project = resolveProjectIdentity("/tmp/wrapup-runner");
		for (const forceKeepLastCompartment of [true, false]) {
			const db = createDb();
			const sessionId = `ses-force-${forceKeepLastCompartment}`;
			try {
				await withProvider(sessionId, 3, () =>
					runWithLease({
						db,
						sessionId,
						snapshot: wrapupSnapshot(db, sessionId),
						forceKeepLastCompartment,
						forceDrainQuota: true,
					}),
				);

				expect(getCompartments(db, sessionId)).toHaveLength(1);
				if (forceKeepLastCompartment) {
					expect(getMemoriesByProject(db, project)).toHaveLength(0);
					expect(getUserMemoryCandidates(db)).toHaveLength(0);
					expect(getPrimerCandidatesForProject(db, project)).toHaveLength(0);
				} else {
					expect(getMemoriesByProject(db, project).length).toBeGreaterThan(0);
				}
			} finally {
				closeQuietly(db);
			}
		}
	});

	it("downgrades forced final keep on token-capped chunks so discard-last healing still applies", async () => {
		const db = createDb();
		const sessionId = "ses-force-mid-loop-has-more";
		const project = resolveProjectIdentity("/tmp/wrapup-runner");
		try {
			const messages = alternatingMessages(10);
			await withProviderMessages(sessionId, messages, async () => {
				const snapshot = {
					...wrapupSnapshot(db, sessionId),
					protectedTailStart: 9,
					protectedTailStartMessageId: "m-9",
					eligibleEndOrdinal: 9,
					eligibleEndMessageId: "m-8",
					rawRangeFingerprint: "",
					trueRawEligibleTokens: 1_000,
				};
				const chunk = readSessionChunk(sessionId, 220, 1, snapshot.eligibleEndOrdinal);
				expect(chunk.hasMore).toBe(true);
				expect(chunk.endIndex).toBeGreaterThanOrEqual(4);
				expect(chunk.endIndex).toBeLessThanOrEqual(6);

				await runWithLease({
					db,
					sessionId,
					snapshot,
					forceKeepLastCompartment: true,
					forceDrainQuota: true,
					historianChunkTokens: 220,
					output: twoCompartmentHistorianXml(),
				});
			});

			// The downgrade proof is the HEALING, not promotion: an un-downgraded
			// forced keep would persist BOTH compartments; the token-capped chunk
			// instead drops the provisional tail (discard-last), and the discarded
			// range re-reads next iteration. Promotion is skipped on discard-last
			// runs by long-standing design (unanchored facts would double-store on
			// the re-read), so no memories may appear here.
			expect(getCompartments(db, sessionId)).toHaveLength(1);
			expect(getCompartments(db, sessionId)[0]?.endMessage).toBe(2);
			expect(getMemoriesByProject(db, project)).toHaveLength(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("forceDrainQuota bypasses an exhausted protected-tail drain window", async () => {
		const db = createDb();
		const sessionId = "ses-quota-bypass";
		try {
			await withProvider(sessionId, 3, async () => {
				const snapshot = wrapupSnapshot(db, sessionId, 83);
				const usable = Math.max(
					1,
					Math.round((snapshot.contextLimit * snapshot.executeThresholdPercentage) / 100),
				);
				const perRunCap = 3;
				expect(
					reserveProtectedTailDrainTokens({
						db,
						sessionId,
						runId: "exhaust-window",
						trueRawTokens: 9,
						usagePercentage: snapshot.usagePercentage,
						usable,
						perRunCap,
						executeThresholdPercentage: snapshot.executeThresholdPercentage,
					}).ok,
				).toBe(true);

				await runWithLease({
					db,
					sessionId,
					snapshot,
					forceDrainQuota: true,
				});
			});
			expect(getCompartments(db, sessionId)).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses refreshBoundarySnapshot when the initial boundary snapshot is stale", async () => {
		const db = createDb();
		const sessionId = "ses-refresh-boundary";
		try {
			await withProvider(sessionId, 3, async () => {
				const fresh = wrapupSnapshot(db, sessionId);
				const stale = {
					...fresh,
					rawMessageCountAtTrigger: 1,
					rawLastMessageIdAtTrigger: "m-1",
					rawRangeFingerprint: "stale-fingerprint",
				};
				const refresh = vi.fn(() => fresh);
				await runWithLease({
					db,
					sessionId,
					snapshot: stale,
					forceDrainQuota: true,
					refreshBoundarySnapshot: refresh,
				});
				expect(refresh).toHaveBeenCalled();
			});
			expect(getCompartments(db, sessionId)[0]?.endMessage).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});
});
