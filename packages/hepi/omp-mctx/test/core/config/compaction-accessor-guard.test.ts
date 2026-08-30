import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// isCompactionEnabled (config/agent-disable.ts) is the ONLY non-schema reader
// of the `compaction.enabled` config path. Every gate site (pi-plugin, cli,
// plugin boot, session hooks) must IMPORT it and never re-derive the value.
// This guard asserts no other source file reads `compaction.enabled` or
// `compaction?.enabled` directly.
//
// The schema file (config/schema/magic-context.ts) is the single producer of
// the path and is excluded; the accessor file (config/agent-disable.ts) is the
// single consumer and is excluded. The storage helpers read a DB column
// (compaction_mode_record), not the config path, so they are not in scope.

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../../..");
const SOURCE_ROOTS = ["packages/pi-mctx/src"];

const ALLOWED_READERS = new Set<string>([
	"packages/pi-mctx/src/config/index.ts",
	"packages/pi-mctx/src/core/config/agent-disable.ts",
	"packages/pi-mctx/src/core/config/schema/magic-context.ts",
]);

function sourceFiles(directory: string): string[] {
	const result: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			result.push(...sourceFiles(path));
		} else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
			result.push(path);
		}
	}
	return result;
}

// Matches direct reads of the config path: `compaction.enabled` or
// `compaction?.enabled` as a property access (not a string literal). This is a
// structural grep, not a full AST parse — it is deliberately conservative and
// may surface false positives, which are then allow-listed only after review.
// It does NOT match the DB column `compaction_mode_record`, the accessor name
// `isCompactionEnabled`, or the schema's own `.object({ enabled: ... })`.
const COMPACTION_ENABLED_READ = /\bcompaction\??\s*\.\s*enabled\b(?!_)/;

describe("compaction.enabled accessor exclusivity (issue #266)", () => {
	it("no non-schema source file reads compaction.enabled directly", () => {
		const offenders: string[] = [];
		for (const root of SOURCE_ROOTS) {
			for (const path of sourceFiles(resolve(REPOSITORY_ROOT, root))) {
				const relativePath = relative(REPOSITORY_ROOT, path);
				if (ALLOWED_READERS.has(relativePath)) continue;
				const source = readFileSync(path, "utf8");
				if (COMPACTION_ENABLED_READ.test(source)) {
					offenders.push(relativePath);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("isCompactionEnabled is exported from the accessor module", async () => {
		const mod = await import("../../../src/core/config/agent-disable");
		expect(typeof mod.isCompactionEnabled).toBe("function");
	});

	it("isCompactionEnabled resolves default-on for absent block and explicit true, off for false", async () => {
		const { isCompactionEnabled } = await import("../../../src/core/config/agent-disable");
		expect(isCompactionEnabled({})).toBe(true);
		expect(isCompactionEnabled({ compaction: {} })).toBe(true);
		expect(isCompactionEnabled({ compaction: { enabled: true } })).toBe(true);
		expect(isCompactionEnabled({ compaction: { enabled: false } })).toBe(false);
		expect(isCompactionEnabled({ compaction: null })).toBe(true);
	});
});
