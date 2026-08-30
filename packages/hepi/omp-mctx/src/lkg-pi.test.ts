import { afterEach, describe, expect, test } from "bun:test";
import { initializeDatabase } from "#core/features/storage-db";
import { captureLkgSlot, replayLkg, resolveLkgModelKeys } from "#core/hooks/lkg-replay";
import {
	createDbLkgPersistence,
	loadPersistedLkgSlot,
	saveLkgSlotToDb,
} from "#core/hooks/lkg-persist";
import {
	dropSlot,
	getSlot,
	noteEntry,
	registerLkgPersistence,
	resetLkgSlotsForTest,
} from "#core/hooks/lkg-slot";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { lkgMessagesToPi, piMessagesToLkg } from "./lkg-pi.ts";

const piMessages = [
	{ role: "user" as const, content: "hello from pi", timestamp: 1 },
	{
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "hi" }],
		api: "openai",
		provider: "openai",
		model: "gpt-test",
		usage: {},
		stopReason: "stop",
		timestamp: 2,
	},
];

describe("Pi LKG adapter", () => {
	afterEach(() => {
		resetLkgSlotsForTest();
	});

	test("round-trips Pi messages through capture, persist, and replay", () => {
		const db = new Database(":memory:");
		try {
			initializeDatabase(db);
			registerLkgPersistence(createDbLkgPersistence(db));
			const entryIds = ["user-1", "asst-1"];
			const like = piMessagesToLkg(piMessages, { entryIds });
			expect(like[0]?.info.id).toBe("user-1");
			expect(like[0]?.info.role).toBe("user");

			const keys = resolveLkgModelKeys(like);
			expect(keys).toEqual({ modelKey: "openai/gpt-test", providerKey: "openai" });
			expect(captureLkgSlot({ sessionId: "s1", input: like, output: like, ...keys })).toBe(true);

			const slot = getSlot("s1");
			expect(slot).toBeDefined();
			expect(saveLkgSlotToDb(db, "s1", slot!)).toBe(true);

			resetLkgSlotsForTest();
			registerLkgPersistence(createDbLkgPersistence(db));
			expect(getSlot("s1")?.lastInputMessageId).toBe("user-1");

			const nextLike = piMessagesToLkg(piMessages, { entryIds });
			const entry = noteEntry("s1", nextLike);
			expect(entry).not.toBeNull();
			const replay = replayLkg({
				sessionId: "s1",
				messages: nextLike,
				...keys,
				entry,
			});
			expect(replay.ok).toBe(true);
			if (!replay.ok) return;
			const restored = lkgMessagesToPi(replay.messages);
			expect(restored[0]).toEqual(piMessages[0]);
			const assistant = restored[1];
			expect(assistant && typeof assistant === "object" && "content" in assistant).toBe(true);
			if (assistant && typeof assistant === "object" && "content" in assistant) {
				expect(assistant.content).toEqual(piMessages[1].content);
			}
			dropSlot("s1");
			expect(loadPersistedLkgSlot(db, "s1")).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});
});
