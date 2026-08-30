import { describe, expect, it } from "vitest";
import {
	createFailClosedBlockingError,
	createFailClosedController,
	FAIL_CLOSED_DOCTOR_COMMAND,
	type FailClosedReason,
	formatFailClosedBlockingMessage,
	isFailClosedBlockingError,
	resolveAgentNameFromMessages,
	shouldBypassFailClosedBlock,
} from "../../../src/core/features/fail-closed-block";

const storageReason: FailClosedReason = {
	kind: "storage_failure",
	cause: "disk full",
};

describe("formatFailClosedBlockingMessage", () => {
	it("includes storage cause and recovery command", () => {
		const message = formatFailClosedBlockingMessage(storageReason);
		expect(message).toContain("disk full");
		expect(message).toContain(FAIL_CLOSED_DOCTOR_COMMAND);
	});
});

describe("shouldBypassFailClosedBlock", () => {
	it("bypasses Magic Context children", () => {
		expect(shouldBypassFailClosedBlock({ agent: "historian" })).toBe(true);
		expect(shouldBypassFailClosedBlock({ agent: "dreamer-docs" })).toBe(true);
		expect(shouldBypassFailClosedBlock({ isInternalChildSession: true })).toBe(true);
		expect(shouldBypassFailClosedBlock({ isPiSubagentEnv: true })).toBe(true);
	});

	it("does not bypass primary sessions", () => {
		expect(shouldBypassFailClosedBlock({ agent: "build" })).toBe(false);
		expect(shouldBypassFailClosedBlock({})).toBe(false);
	});
});

describe("createFailClosedController", () => {
	it("throws while storage remains unavailable", async () => {
		const gate = createFailClosedController({ reprobeEveryN: 5 });
		gate.arm(storageReason);
		await expect(gate.enforce({ blockingEnabled: true, exempt: false })).rejects.toMatchObject({
			code: "FAIL_CLOSED_BLOCKING",
		});
	});

	it("clears after storage recovers", async () => {
		const gate = createFailClosedController({ reprobeEveryN: 2 });
		gate.arm(storageReason);
		let opens = 0;
		const tryReopen = async () => {
			opens += 1;
			return opens >= 2;
		};

		await expect(
			gate.enforce({ blockingEnabled: true, exempt: false, tryReopen }),
		).rejects.toBeInstanceOf(Error);
		await expect(
			gate.enforce({ blockingEnabled: true, exempt: false, tryReopen }),
		).resolves.toBeUndefined();
		expect(gate.isArmed()).toBe(false);
		expect(opens).toBe(2);
	});
});

describe("fail-closed errors", () => {
	it("sets a stable error identity", () => {
		const error = createFailClosedBlockingError(storageReason);
		expect(isFailClosedBlockingError(error)).toBe(true);
		expect(error.name).toBe("FailClosedBlockingError");
		expect(error.code).toBe("FAIL_CLOSED_BLOCKING");
	});
});

describe("resolveAgentNameFromMessages", () => {
	it("reads the newest message agent field", () => {
		expect(
			resolveAgentNameFromMessages([{ info: { agent: "build" } }, { info: { agent: "title" } }]),
		).toBe("title");
	});
});
