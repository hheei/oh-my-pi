/**
 * Fork-owned grouped-Read usage layout.
 *
 * Upstream nests usage under the last tree path. This fork inserts a blank
 * separator after the files and paints usage flush left — no title-column or
 * tree-gutter indent.
 */
export function appendGroupedReadUsageLines(lines: string[], paintedRows: readonly string[]): void {
	if (paintedRows.length === 0) return;
	lines.push("");
	for (const row of paintedRows) {
		lines.push(row);
	}
}
