/**
 * Fork-owned indent for grouped-Read usage rows.
 *
 * Upstream nests usage under the last tree path via the continuation gutter
 * (`│` mid-list, spaces under `└─`), which makes the metrics look like a
 * child of that file. This fork keeps the row after the last path it covers,
 * but aligns it with the group title column.
 */
export const GROUPED_READ_USAGE_PREFIX = "   ";
