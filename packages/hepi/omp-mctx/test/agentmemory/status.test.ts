import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../src/core/shared/sqlite";
import { closeQuietly } from "../../src/core/shared/sqlite-helpers";
import { commitHistorianPublication } from "../../src/agentmemory/outbox";
import { admitRecallEvent, ensureRecallLedgerSchema, recordProjectionEpoch } from "../../src/agentmemory/recall-ledger";
import {
	readAgentMemoryStatus,
	recordAgentMemoryOperation,
	resetAgentMemoryObservedRuntimeState,
} from "../../src/agentmemory/status";

const databases: Database[] = [];
afterEach(() => {
	resetAgentMemoryObservedRuntimeState();
	for (const db of databases.splice(0)) closeQuietly(db);
});

function database(): Database {
	const db = new Database(":memory:");
	databases.push(db);
	ensureRecallLedgerSchema(db);
	return db;
}

const enabledSettings = {
	enabled: true,
	url: "http://127.0.0.1:3111",
	secret: "never-rendered",
	project: "project",
	capture: true,
	inject: true,
	historianRetrieval: true,
	memoryTools: true,
	requireHttps: false,
};

describe("agentmemory local status", () => {
	test("reads only active-branch committed recalls with sanitized previews and outbox state", () => {
		const db = database();
		recordProjectionEpoch(db, {
			epochId: "main-epoch",
			sessionId: "session",
			branchId: "main",
			reason: "upgrade",
			rendererVersion: "test",
			contractDigest: "contract",
			snapshotDigest: "main",
		});
		recordProjectionEpoch(db, {
			epochId: "other-epoch",
			sessionId: "session",
			branchId: "other",
			reason: "upgrade",
			rendererVersion: "test",
			contractDigest: "contract",
			snapshotDigest: "other",
		});
		const active = admitRecallEvent(db, {
			sessionId: "session",
			branchId: "main",
			epochId: "main-epoch",
			userEntryAnchor: "user-main",
			body: new TextEncoder().encode("actual\trecall /home/chlo/project"),
			origin: "direct_retrieval",
			promotionEligibility: "requires_independent_evidence",
			sources: [{ sourceId: "memory-1", sourceKind: "memory", contentDigest: "digest", project: "project", scope: { project: "project" } }],
			dependencies: [],
		});
		admitRecallEvent(db, {
			sessionId: "session",
			branchId: "other",
			epochId: "other-epoch",
			userEntryAnchor: "user-other",
			body: new TextEncoder().encode("sibling secret"),
			origin: "direct_retrieval",
			promotionEligibility: "requires_independent_evidence",
			sources: [{ sourceId: "lesson-1", sourceKind: "lesson", contentDigest: "digest", project: "project", scope: { project: "project" } }],
			dependencies: [],
		});
		commitHistorianPublication(db, {
			candidate: { project: "project", content: "pending save" },
			writeWindow: () => undefined,
			now: 100,
		});
		db.prepare("UPDATE agentmemory_outbox SET state = 'failed', next_attempt_at = 200, last_error = 'backend\t/secret/path'").run();

		recordAgentMemoryOperation("search", "failure", new Error("backend down"));
		const status = readAgentMemoryStatus(db, "session", "main", enabledSettings, 300);

		expect(status.bridgeState).toBe("degraded");
		expect(status.gates).toEqual({ bridge: true, capture: true, inject: true, historianRetrieval: true, memoryTools: true });
		expect(status.recallCount).toBe(1);
		expect(status.sourceKindCounts).toEqual({ memory: 1 });
		expect(status.recallPreviews).toMatchObject([{ eventId: active.eventId, sourceKinds: ["memory"] }]);
		expect(status.recallPreviews[0]?.preview).toContain("actual");
		expect(status.recallPreviews[0]?.preview).not.toContain("sibling secret");
		expect(new TextDecoder().decode(active.body)).toBe("actual\trecall /home/chlo/project");
		expect(status.outbox).toMatchObject({ failed: 1, pending: 0, nextRetryAt: 200 });
		expect(status.outbox.latestError).not.toContain("\t");
		const siblingStatus = readAgentMemoryStatus(db, "session", "other", enabledSettings, 300);
		expect(siblingStatus.recallCount).toBe(1);
		expect(siblingStatus.recallPreviews[0]?.preview).toContain("sibling secret");
	});
	test("distinguishes disabled, unknown, and healthy observations without probing", () => {
		const db = database();
		const disabled = readAgentMemoryStatus(db, "session", "main", { ...enabledSettings, enabled: false });
		expect(disabled.bridgeState).toBe("disabled");
		expect(disabled.gates).toEqual({ bridge: false, capture: false, inject: false, historianRetrieval: false, memoryTools: false });
		expect(readAgentMemoryStatus(db, "session", "main", enabledSettings).bridgeState).toBe("unknown");
		recordAgentMemoryOperation("health", "success");
		expect(readAgentMemoryStatus(db, "session", "main", enabledSettings).bridgeState).toBe("healthy");
	});
	test("clears a historical bridge error after a later success", () => {
		const db = database();
		recordAgentMemoryOperation("search", "failure", new Error("temporary outage"));
		recordAgentMemoryOperation("health", "success");
		const status = readAgentMemoryStatus(db, "session", "main", enabledSettings);
		expect(status.bridgeState).toBe("healthy");
		expect(status.observed.lastError).toBeNull();
		expect(status.observed.lastResult).toBe("success");
	});
});
