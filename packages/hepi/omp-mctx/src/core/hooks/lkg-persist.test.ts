import { afterEach, describe, expect, test } from "bun:test";
import { initializeDatabase } from "../features/storage-db.ts";
import { Database } from "../shared/sqlite.ts";
import { closeQuietly } from "../shared/sqlite-helpers.ts";
import {
	clearPersistedLkgSlot,
	createDbLkgPersistence,
	loadPersistedLkgSlot,
	parsePersistedLkgSlot,
	saveLkgSlotToDb,
} from "./lkg-persist.ts";
import {
	dropSlot,
	getSlot,
	registerLkgPersistence,
	resetLkgSlotsForTest,
	type LkgSlot,
} from "./lkg-slot.ts";

const slot: LkgSlot = {
	jsonPrefix: '{"messages":[]}',
	inputIdSeq: ["a", "b"],
	inputContentDigests: ["d1", "d2"],
	lastInputMessageId: "b",
	modelKey: "gpt",
	providerKey: "openai",
	capturedAt: 1,
};

describe("lkg-persist", () => {
	afterEach(() => {
		resetLkgSlotsForTest();
	});

	test("round-trips a slot through SQLite", () => {
		const db = new Database(":memory:");
		try {
			initializeDatabase(db);
			expect(saveLkgSlotToDb(db, "s1", slot)).toBe(true);
			expect(loadPersistedLkgSlot(db, "s1")).toEqual(slot);
			clearPersistedLkgSlot(db, "s1");
			expect(loadPersistedLkgSlot(db, "s1")).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});

	test("hydrates getSlot after an in-memory miss", () => {
		const db = new Database(":memory:");
		try {
			initializeDatabase(db);
			saveLkgSlotToDb(db, "s2", slot);
			resetLkgSlotsForTest();
			registerLkgPersistence(createDbLkgPersistence(db));
			expect(getSlot("s2")).toEqual(slot);
			dropSlot("s2");
			expect(getSlot("s2")).toBeUndefined();
			expect(loadPersistedLkgSlot(db, "s2")).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});

	test("rejects malformed persisted JSON", () => {
		expect(
			parsePersistedLkgSlot({
				json_prefix: "{}",
				input_id_seq: "[1]",
				input_content_digests: '["d"]',
				last_input_message_id: "x",
				captured_at: 1,
			}),
		).toBeUndefined();
	});
});
