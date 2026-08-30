import { describe, expect, test } from "bun:test";
import {
	FAIL_CLOSED_RECOVERY_GUIDANCE,
	formatFailClosedBlockingMessage,
} from "./fail-closed-block";

describe("fail-closed recovery guidance", () => {
	test("directs OMP users to the isolated plugin store", () => {
		const message = formatFailClosedBlockingMessage({
			kind: "storage_failure",
			cause: "database is locked",
		});
		expect(message).toContain(FAIL_CLOSED_RECOVERY_GUIDANCE);
		expect(message).toContain("~/.omp/agent/extensions/omp-mctx/context.db");
		expect(message).not.toContain("@cortexkit");
		expect(message).not.toContain("npx");
	});
});
