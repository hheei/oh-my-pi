import { afterEach, describe, expect, test } from "bun:test";
import { formatRecallPresentationLines, presentAdmittedRecall } from "../../src/agentmemory/recall-presentation";
import {
	admitRecallEvent,
	ensureRecallLedgerSchema,
	recordProjectionEpoch,
	type RecallEvent,
} from "../../src/agentmemory/recall-ledger";
import { Database } from "../../src/core/shared/sqlite";

const databases: Database[] = [];

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function createDb(): Database {
	const db = new Database(":memory:");
	ensureRecallLedgerSchema(db);
	recordProjectionEpoch(db, {
		epochId: "epoch",
		sessionId: "session",
		branchId: "main",
		reason: "upgrade",
		rendererVersion: "test",
		contractDigest: "contract",
		snapshotDigest: "snapshot",
	});
	databases.push(db);
	return db;
}

function createEvent(db: Database, body = "remember this"): RecallEvent {
	return admitRecallEvent(db, {
		sessionId: "session",
		branchId: "main",
		userEntryAnchor: "user-1",
		epochId: "epoch",
		body: new TextEncoder().encode(body),
		origin: "direct_retrieval",
		promotionEligibility: "requires_independent_evidence",
		sources: [
			{
				sourceId: "memory-1",
				sourceKind: "memory",
				contentDigest: "digest",
				project: "project",
				scope: {},
			},
		],
		dependencies: [],
	});
}

type WidgetCall = { key: string; lines: string[]; placement: "aboveEditor" | undefined };

function createUi(throws = false): {
	ui: { setWidget: (key: string, lines: string[], options?: { placement?: "aboveEditor" }) => void };
	calls: WidgetCall[];
} {
	const calls: WidgetCall[] = [];
	return {
		ui: {
			setWidget(key, lines, options): void {
				calls.push({ key, lines, placement: options?.placement });
				if (throws) throw new Error("widget unavailable");
			},
		},
		calls,
	};
}

function receiptState(db: Database, event: RecallEvent): string {
	const receipt = db
		.prepare("SELECT state FROM mctx_recall_presentation_receipts WHERE event_id = ? AND surface = 'tui'")
		.get(event.eventId) as { state: string };
	return receipt.state;
}

describe("recall presentation", () => {
	test("sanitizes display lines without changing admitted provider bytes", () => {
		const db = createDb();
		const body = "\t/home/chlo/Documents/very-long-memory";
		const event = createEvent(db, body);
		const original = new Uint8Array(event.body);

		const lines = formatRecallPresentationLines(event, 200);

		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\t");
		expect(event.body).toEqual(original);
		expect(new TextDecoder().decode(event.body)).toBe(body);
	});

	test("claims and completes once so a retry does not reprint", () => {
		const db = createDb();
		const event = createEvent(db);
		const { ui, calls } = createUi();

		expect(presentAdmittedRecall({ db, ui, hasUI: true, event, presenterToken: "session" })).toEqual({
			presented: true,
		});
		expect(presentAdmittedRecall({ db, ui, hasUI: true, event, presenterToken: "session" })).toEqual({
			presented: false,
			reason: "already-presented",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ key: "agentmemory-recall", placement: "aboveEditor" });
		expect(receiptState(db, event)).toBe("presented");
	});

	test("does not claim or render without an interactive UI", () => {
		const db = createDb();
		const event = createEvent(db);
		const { ui, calls } = createUi();

		expect(presentAdmittedRecall({ db, ui, hasUI: false, event, presenterToken: "session" })).toEqual({
			presented: false,
			reason: "headless",
		});
		expect(calls).toHaveLength(0);
		expect(receiptState(db, event)).toBe("pending");
	});

	test("contains widget rendering errors without completing the receipt", () => {
		const db = createDb();
		const event = createEvent(db);
		const { ui, calls } = createUi(true);

		expect(presentAdmittedRecall({ db, ui, hasUI: true, event, presenterToken: "session" })).toEqual({
			presented: false,
			reason: "ui-error",
		});
		expect(calls).toHaveLength(1);
		expect(receiptState(db, event)).toBe("claimed");
	});
});
