import { shortenPath } from "../../tools/render-utils";

/** Keep the last two path segments when compacting a grouped-Read display path. */
export const GROUPED_READ_PATH_TAIL_SEGMENTS = 2;

/**
 * Fork-owned grouped-Read path display.
 *
 * Upstream paints the full shortened path, which wraps after the tree
 * connector on long absolute paths. This fork keeps `shortenPath` (`~`) then
 * cuts the prefix down to `…/dir/file` when more than two segments remain.
 */
export function formatGroupedReadDisplayPath(filePath: string): string {
	const shortened = shortenPath(filePath);
	if (!shortened) return shortened;
	const parts = shortened.split(/[\\/]/).filter(part => part.length > 0 && part !== ".");
	if (parts.length <= GROUPED_READ_PATH_TAIL_SEGMENTS) return shortened;
	return `…/${parts.slice(-GROUPED_READ_PATH_TAIL_SEGMENTS).join("/")}`;
}
