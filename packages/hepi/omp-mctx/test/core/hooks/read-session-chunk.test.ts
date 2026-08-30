import { describe, expect, it } from "vitest";
import {
	getProtectedTailStartOrdinal,
	readRawSessionMessages,
	readSessionChunk,
	withRawMessageProvider,
	withRawSessionMessageCache,
} from "../../../src/core/hooks/read-session-chunk";
import type { RawMessage } from "../../../src/core/hooks/read-session-raw";

function message(id: string, ordinal: number, role: string, text: string): RawMessage {
	return {
		id,
		ordinal,
		role,
		parts: [{ type: "text", text }],
	};
}

describe("readSessionChunk", () => {
	it("reads provider messages with stable ordinals and ids", () => {
		const messages = [message("m-1", 1, "user", "hello"), message("m-2", 2, "assistant", "done")];

		withRawMessageProvider("session", { readMessages: () => messages }, () => {
			const chunk = readSessionChunk("session", 10_000, 1);

			expect(chunk.startIndex).toBe(1);
			expect(chunk.endIndex).toBe(2);
			expect(chunk.startMessageId).toBe("m-1");
			expect(chunk.endMessageId).toBe("m-2");
			expect(chunk.text).toContain("[1] U: hello");
			expect(chunk.text).toContain("[2] A: done");
		});
	});

	it("caches provider reads only within the explicit cache scope", () => {
		const messages = [message("m-1", 1, "user", "turn")];
		let reads = 0;

		withRawMessageProvider(
			"session",
			{
				readMessages: () => {
					reads += 1;
					return messages;
				},
			},
			() => {
				withRawSessionMessageCache(() => {
					expect(readRawSessionMessages("session")).toBe(readRawSessionMessages("session"));
				});
				expect(reads).toBe(1);
			},
		);
	});

	it("keeps the latest five user turns protected", () => {
		const messages: RawMessage[] = [];
		for (let ordinal = 1; ordinal <= 12; ordinal += 1) {
			messages.push(
				message(
					`m-${ordinal}`,
					ordinal,
					ordinal % 2 === 1 ? "user" : "assistant",
					`turn ${ordinal}`,
				),
			);
		}

		withRawMessageProvider("session", { readMessages: () => messages }, () => {
			expect(getProtectedTailStartOrdinal("session")).toBe(3);
		});
	});
});
