/**
 * Fork-owned grouped-Read usage layout.
 *
 * Upstream nests usage under the last tree path via the continuation gutter.
 * This fork inserts a blank separator after the files and paints usage at the
 * tool-title column (` • Read`), not the child-tree gutter.
 */
export const GROUPED_READ_USAGE_PREFIX = " ";

export function appendGroupedReadUsageLines(lines: string[], paintedRows: readonly string[]): void {
	if (paintedRows.length === 0) return;
	lines.push("");
	for (const row of paintedRows) {
		lines.push(row);
	}
}
