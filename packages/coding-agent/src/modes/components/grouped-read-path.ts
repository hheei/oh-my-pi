import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { shortenPath } from "../../tools/render-utils";

const ELLIPSIS_PREFIX = "…/";

/**
 * Fork-owned grouped-Read path display.
 *
 * Upstream paints the full shortened path, which wraps after the tree
 * connector. This fork keeps `shortenPath` (`~`) and, only when the path is
 * wider than `maxWidth`, drops the fewest leading segments needed so the
 * remainder fits as `…/rest/file`.
 */
export function formatGroupedReadDisplayPath(filePath: string, maxWidth?: number): string {
	const shortened = shortenPath(filePath);
	if (!shortened) return shortened;
	if (maxWidth === undefined || visibleWidth(shortened) <= maxWidth) return shortened;
	if (maxWidth <= 0) return "";

	const parts = shortened.split(/[\\/]/).filter(part => part.length > 0 && part !== ".");
	if (parts.length === 0) return truncateToWidth(shortened, maxWidth);

	for (let drop = 1; drop < parts.length; drop++) {
		const candidate = `${ELLIPSIS_PREFIX}${parts.slice(drop).join("/")}`;
		if (visibleWidth(candidate) <= maxWidth) return candidate;
	}

	return truncateToWidth(`${ELLIPSIS_PREFIX}${parts[parts.length - 1]}`, maxWidth);
}
