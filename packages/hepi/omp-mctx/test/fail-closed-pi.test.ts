import { describe, expect, it } from "vitest";
import {
	FAIL_CLOSED_DOCTOR_COMMAND,
	isFailClosedBlockingError,
} from "#core/features/fail-closed-block";
import type { ContextDatabase } from "#core/features/storage";

import { registerPiFailClosedSurface } from "../src/fail-closed-pi";

type Handler = (...args: unknown[]) => unknown;

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	return {
		pi: {
			on(event: string, handler: Handler) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		},
		async emit(event: string, ...args: unknown[]) {
			let last: unknown;
			for (const handler of handlers.get(event) ?? []) last = await handler(...args);
			return last;
		},
	};
}

describe("registerPiFailClosedSurface", () => {
	it("cancels compaction and reports storage failure", async () => {
		const fake = createFakePi();
		registerPiFailClosedSurface(fake.pi as never, {
			reason: { kind: "storage_failure", cause: "disk full" },
			tryReopen: async () => null,
			onRecovered: async () => {},
		});

		await expect(fake.emit("session_before_compact", {}, {})).resolves.toEqual({
			cancel: true,
		});
		let thrown: unknown;
		try {
			await fake.emit("context", { messages: [] }, {});
		} catch (error) {
			thrown = error;
		}
		expect(isFailClosedBlockingError(thrown)).toBe(true);
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("disk full");
		expect((thrown as Error).message).toContain(FAIL_CLOSED_DOCTOR_COMMAND);
	});

	it("starts runtime after storage reopens", async () => {
		const fake = createFakePi();
		let recovered = false;
		const fakeDb = { __test: true } as unknown as ContextDatabase;
		registerPiFailClosedSurface(fake.pi as never, {
			reason: { kind: "storage_failure", cause: "database unavailable" },
			tryReopen: async () => fakeDb,
			onRecovered: async (db) => {
				expect(db).toBe(fakeDb);
				recovered = true;
			},
		});

		await expect(fake.emit("context", { messages: [] }, {})).resolves.toBeUndefined();
		expect(recovered).toBe(true);
	});
});
