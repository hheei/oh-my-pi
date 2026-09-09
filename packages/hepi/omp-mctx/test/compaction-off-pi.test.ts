import { describe, expect, it } from "vitest";
import {
	getPendingOps,
	insertTag,
	queuePendingOp,
	setChannel2NudgeState,
	updateSessionMeta,
} from "#core/features/storage";
import { setPendingPiCompactionMarkerState } from "#core/features/storage-meta-persisted";
import {
	getChannel2NudgeState,
	getCompactionModeRecord,
	getOverflowState,
	recordOverflowDetected,
} from "#core/features/storage-meta-persisted";
import { closeQuietly } from "#core/shared/sqlite-helpers";

import { commitPiCompactionModeRecord, reconcilePiCompactionMode } from "../src/compaction-off-pi";
import {
	handlePiSessionBeforeCompact,
	handlePiSessionCompact,
} from "../src/index";
import {
	consumeDeferredHistoryRefresh,
	consumeDeferredMaterialization,
} from "../src/context-handler";
import { createTestDb } from "./test-utils.test";

describe("Pi compaction-off mode", () => {
	it("allows native compaction in every mode and clears cached m[0]/m[1] first", async () => {
		const db = createTestDb();
		const sessionId = "ses-native";
		try {
			const ctx = { sessionManager: { getSessionId: () => sessionId } };
			for (const compactionOff of [false, true]) {
				updateSessionMeta(db, sessionId, {
					cachedM0Bytes: Buffer.from("cached m0"),
					cachedM1Bytes: Buffer.from("cached m1"),
				});
				db.prepare("UPDATE session_meta SET cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?").run(
					"stale-boundary",
					sessionId,
				);
				expect(await handlePiSessionBeforeCompact({ db, compactionOff, ctx })).toBeUndefined();
				expect(
					db
						.prepare(
							"SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_last_baseline_end_message_id FROM session_meta WHERE session_id = ?",
						)
						.get(sessionId),
				).toEqual({ cached_m0_bytes: null, cached_m1_bytes: null, cached_m0_last_baseline_end_message_id: null });
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("signals deferred reconciliation idempotently after native compaction", () => {
		const db = createTestDb();
		const sessionId = "ses-native-post";
		try {
			const ctx = { sessionManager: { getSessionId: () => sessionId } };
			handlePiSessionCompact({ db, ctx });
			handlePiSessionCompact({ db, ctx });
			expect(consumeDeferredHistoryRefresh(sessionId)).toBe(true);
			expect(consumeDeferredHistoryRefresh(sessionId)).toBe(false);
			expect(consumeDeferredMaterialization(sessionId)).toBe(true);
			expect(consumeDeferredMaterialization(sessionId)).toBe(false);
		} finally {
			closeQuietly(db);
		}
	});

	it("treats no record plus off as a full Pi cleanup transition", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-off-transition";
		try {
			const tag = insertTag(db, sessionId, "message-1", "message", 20, 1);
			queuePendingOp(db, sessionId, tag, "drop");
			setPendingPiCompactionMarkerState(db, sessionId, {
				firstKeptEntryId: "entry-2",
				endMessageId: "entry-1",
				ordinal: 1,
				tokensBefore: 100,
				summary: "stale MC compaction",
				publishedAt: 1,
				generation: 0,
			});
			recordOverflowDetected(db, sessionId, undefined);
			setChannel2NudgeState(db, sessionId, "pending");
			updateSessionMeta(db, sessionId, {
				cachedM0Bytes: Buffer.from("old on-mode history"),
				cachedM1Bytes: Buffer.from("old on-mode delta"),
				compartmentInProgress: true,
			});

			const transition = reconcilePiCompactionMode({
				db,
				sessionId,
				compactionOff: true,
				historianRunnable: true,
			});
			expect(transition.recordToWrite).toBe("off");
			expect(getCompactionModeRecord(db, sessionId)).toBe("off_notice_pending");
			expect(transition.clearDeferredMarkerState).toBe(true);
			expect(getPendingOps(db, sessionId)).toEqual([]);
			expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(false);
			expect(getChannel2NudgeState(db, sessionId)).toBe("");
			expect(
				db
					.prepare(
						"SELECT pending_pi_compaction_marker_state, cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id = ?",
					)
					.get(sessionId),
			).toMatchObject({
				pending_pi_compaction_marker_state: null,
				cached_m0_bytes: null,
				cached_m1_bytes: null,
			});

			commitPiCompactionModeRecord(db, sessionId, "off");
			expect(getCompactionModeRecord(db, sessionId)).toBe("off");
			expect(
				reconcilePiCompactionMode({
					db,
					sessionId,
					compactionOff: true,
					historianRunnable: true,
				}).recordToWrite,
			).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("records no-record plus on without cleanup, then signals one flip-back catch-up", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-on-transition";
		try {
			const initial = reconcilePiCompactionMode({
				db,
				sessionId,
				compactionOff: false,
				historianRunnable: true,
			});
			expect(initial.recordToWrite).toBe("on");
			commitPiCompactionModeRecord(db, sessionId, "on");

			commitPiCompactionModeRecord(db, sessionId, "off");
			const resumed = reconcilePiCompactionMode({
				db,
				sessionId,
				compactionOff: false,
				historianRunnable: true,
			});
			expect(resumed.recordToWrite).toBe("on");
			expect(getCompactionModeRecord(db, sessionId)).toBe("on_notice_pending");
			expect(resumed.historianCatchUpSignaled).toBe(true);
			expect(resumed.notice).toContain("/ctx-wrapup");
		} finally {
			closeQuietly(db);
		}
	});

	it("retries a durable flip-off notice after a fresh reconciliation", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-notice-restart";
		try {
			queuePendingOp(db, sessionId, 9, "drop");
			const first = reconcilePiCompactionMode({
				db,
				sessionId,
				compactionOff: true,
				historianRunnable: true,
			});
			expect(first.notice).toContain("compaction-off mode");
			expect(getCompactionModeRecord(db, sessionId)).toBe("off_notice_pending");

			// Simulate restart after the clears committed but before the caller
			// reached Pi's UI. The pending record, not process memory, requests
			// the same notice again.
			const restarted = reconcilePiCompactionMode({
				db,
				sessionId,
				compactionOff: true,
				historianRunnable: true,
			});
			expect(restarted.notice).toBe(first.notice);
			const recordToWrite = restarted.recordToWrite;
			if (!recordToWrite) throw new Error("expected a compaction mode record to persist");
			commitPiCompactionModeRecord(db, sessionId, recordToWrite);
			expect(getCompactionModeRecord(db, sessionId)).toBe("off");
		} finally {
			closeQuietly(db);
		}
	});
});
