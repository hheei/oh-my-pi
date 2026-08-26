import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { formatGroupedReadDisplayPath } from "./grouped-read-path";

describe("formatGroupedReadDisplayPath", () => {
	it("keeps the full shortened path when no width budget is given", () => {
		expect(formatGroupedReadDisplayPath("/tmp/a/b/c.ts")).toBe("/tmp/a/b/c.ts");
		expect(formatGroupedReadDisplayPath("src/modes/example.ts")).toBe("src/modes/example.ts");
	});

	it("keeps the full path when it already fits", () => {
		const filePath = "/tmp/a/b/c.ts";
		expect(formatGroupedReadDisplayPath(filePath, visibleWidth(filePath))).toBe(filePath);
		expect(formatGroupedReadDisplayPath(filePath, visibleWidth(filePath) + 8)).toBe(filePath);
	});

	it("drops the fewest leading segments that still fit", () => {
		const filePath = "/tmp/pkg/src/modes/components/file.ts";
		const fullWidth = visibleWidth(filePath);
		expect(formatGroupedReadDisplayPath(filePath, fullWidth - 1)).toBe("…/pkg/src/modes/components/file.ts");
		expect(formatGroupedReadDisplayPath(filePath, visibleWidth("…/modes/components/file.ts"))).toBe(
			"…/modes/components/file.ts",
		);
		expect(formatGroupedReadDisplayPath(filePath, visibleWidth("…/components/file.ts"))).toBe("…/components/file.ts");
	});

	it("keeps a home-shortened path that fits", () => {
		const filePath = path.join(os.homedir(), ".herdr", "worktrees", "pkg", "src", "file.ts");
		expect(formatGroupedReadDisplayPath(filePath)).toBe("~/.herdr/worktrees/pkg/src/file.ts");
		expect(formatGroupedReadDisplayPath(filePath, 200)).toBe("~/.herdr/worktrees/pkg/src/file.ts");
	});

	it("truncates a single overlong segment", () => {
		const filePath = "/tmp/very-long-filename-that-cannot-fit.ts";
		const compacted = formatGroupedReadDisplayPath(filePath, 12);
		expect(visibleWidth(compacted)).toBeLessThanOrEqual(12);
		expect(compacted.startsWith("…")).toBe(true);
	});
});
