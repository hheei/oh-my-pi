/**
 * Fork-owned TODO HUD spine layout.
 *
 * Upstream paints an always-open `├─`/`│` spine plus a dummy elbow tail
 * (`└────`) as the overall progress path. This fork closes the last stage
 * with a real last-sibling connector so a single group is not followed by
 * an empty branch.
 */
import { replaceTabs } from "../tools/render-utils";
import { getTreeBranch, getTreeContinuePrefix } from "../tui/utils";
import type { Theme } from "./theme/theme";

export function layoutTodoHudSpine(
	blocks: ReadonlyArray<string | string[]>,
	uiTheme: Theme,
): { spineGlyphs: string[]; contentLines: string[] } {
	const spineGlyphs: string[] = [];
	const contentLines: string[] = [];
	const nonempty: string[][] = [];
	for (const block of blocks) {
		const rows = Array.isArray(block) ? block : [block];
		if (rows.length === 0) continue;
		nonempty.push(rows);
	}

	for (let i = 0; i < nonempty.length; i++) {
		const rows = nonempty[i]!;
		const isLast = i === nonempty.length - 1;
		spineGlyphs.push(`${getTreeBranch(isLast, uiTheme)} `);
		contentLines.push(replaceTabs(rows[0]!));
		const continuePrefix = getTreeContinuePrefix(isLast, uiTheme);
		for (let row = 1; row < rows.length; row++) {
			spineGlyphs.push(continuePrefix);
			contentLines.push(replaceTabs(rows[row]!));
		}
	}

	return { spineGlyphs, contentLines };
}
