import { describe, expect, it } from "vitest";
import { initializeDatabase } from "../../../src/core/features/storage";
import {
	executeContextRecomp,
	getActiveCompartmentRun,
	registerActiveCompartmentRun,
} from "../../../src/core/hooks/compartment-runner";
import { Database } from "../../../src/core/shared/sqlite";

describe("executeContextRecomp", () => {
	it("does not rebuild when Pi supplies no raw history", async () => {
		const db = new Database(":memory:");
		initializeDatabase(db);
		try {
			const result = await executeContextRecomp({
				client: { session: {} } as never,
				db,
				sessionId: "empty-session",
				historianChunkTokens: 10_000,
				directory: "/tmp",
			});
			expect(result).toBe("## Magic Recomp\n\nNo raw history exists, so nothing was rebuilt.");
		} finally {
			db.close();
		}
	});
});

describe("registerActiveCompartmentRun", () => {
	it("exposes a pending run and clears it after settlement", async () => {
		let release!: () => void;
		const run = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registered = registerActiveCompartmentRun("session", run);
		expect(getActiveCompartmentRun("session")).toBe(registered);
		release();
		await registered;
		expect(getActiveCompartmentRun("session")).toBeUndefined();
	});

	it("does not clear a newer run when an older run settles", async () => {
		let releaseFirst!: () => void;
		const first = registerActiveCompartmentRun(
			"session",
			new Promise<void>((resolve) => {
				releaseFirst = resolve;
			}),
		);
		let releaseSecond!: () => void;
		const second = registerActiveCompartmentRun(
			"session",
			new Promise<void>((resolve) => {
				releaseSecond = resolve;
			}),
		);
		releaseFirst();
		await first;
		expect(getActiveCompartmentRun("session")).toBe(second);
		releaseSecond();
		await second;
		expect(getActiveCompartmentRun("session")).toBeUndefined();
	});
});
