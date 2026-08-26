import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { formatGroupedReadDisplayPath } from "./grouped-read-path";

describe("formatGroupedReadDisplayPath", () => {
	it("keeps short paths that already have two segments or fewer", () => {
		expect(formatGroupedReadDisplayPath("/tmp/example.ts")).toBe("/tmp/example.ts");
		expect(formatGroupedReadDisplayPath("src/example.ts")).toBe("src/example.ts");
		expect(formatGroupedReadDisplayPath("CHANGELOG.md")).toBe("CHANGELOG.md");
	});

	it("cuts a long prefix down to the last two segments", () => {
		const filePath = path.join(
			"/home/chlo/.herdr/worktrees/oh-my-pi/feat-read-usage-title-align/packages/coding-agent/src/modes/components",
			"grouped-read-usage-prefix.ts",
		);
		expect(formatGroupedReadDisplayPath(filePath)).toBe("…/components/grouped-read-usage-prefix.ts");
	});

	it("keeps a home-shortened two-segment path", () => {
		const filePath = path.join(os.homedir(), "notes.md");
		expect(formatGroupedReadDisplayPath(filePath)).toBe("~/notes.md");
	});

	it("compacts a nested home path after ~ replacement", () => {
		const filePath = path.join(os.homedir(), ".herdr", "worktrees", "pkg", "src", "file.ts");
		expect(formatGroupedReadDisplayPath(filePath)).toBe("…/src/file.ts");
	});
});
