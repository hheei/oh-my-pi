import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { closeDatabase, openDatabase } from "../../src/core/features/storage-db";
import { checkPreconditions } from "../../src/handoff/command";

function ctx(overrides: Record<string, unknown> = {}) {
	return {
		sessionManager: {
			isPersisted: () => true,
			getSessionId: () => "sess-1",
			getSessionFile: () => "/tmp/s.jsonl",
			getEntries: () => [],
		},
		model: { provider: "anthropic", id: "claude" },
		cwd: "/tmp",
		...overrides,
	};
}

describe("handoff preconditions", () => {
	test("rejects arguments, unpersisted sessions, compaction-off, and missing historian", () => {
		const saved = process.env.XDG_DATA_HOME;
		const tmpRoot = mkdtempSync(join(tmpdir(), "handoff-pre-"));
		process.env.XDG_DATA_HOME = tmpRoot;
		closeDatabase();
		const db = openDatabase();
		if (!db) throw new Error("expected database");
		try {
			const deps = {
				db,
				compactionOff: false,
				historianModel: "anthropic/claude",
			};
			expect(checkPreconditions({} as never, deps as never, ctx() as never, "goal")).toMatchObject({
				ok: false,
			});
			expect(
				checkPreconditions(
					{} as never,
					{ ...deps, compactionOff: true } as never,
					ctx() as never,
					"",
				),
			).toMatchObject({ ok: false });
			expect(
				checkPreconditions(
					{} as never,
					deps as never,
					ctx({
						sessionManager: {
							isPersisted: () => false,
							getSessionId: () => "sess-1",
						},
					}) as never,
					"",
				),
			).toMatchObject({ ok: false });
			expect(
				checkPreconditions(
					{} as never,
					{ ...deps, historianModel: undefined } as never,
					ctx() as never,
					"",
				),
			).toMatchObject({ ok: false });
			expect(checkPreconditions({} as never, deps as never, ctx() as never, "")).toMatchObject({
				ok: true,
			});
		} finally {
			closeDatabase();
			if (saved === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = saved;
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});
