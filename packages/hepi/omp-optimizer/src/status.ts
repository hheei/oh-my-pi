/** Shared status-bar state for the optimizer tools. */

import type { ExtensionCommandContext, ExtensionContext, ThemeColor } from "@oh-my-pi/pi-coding-agent";

export interface OptimizerHandle {
	name: OptimizerTool;
	help: string;
	values: readonly string[];
	current(): string;
	run(value: string, ctx: ExtensionCommandContext): Promise<void> | void;
}

export const STATUS_KEY = "omp-optimizer";
export type OptimizerTool = "caveman" | "rtk" | "ponytail" | "t2s" | "edit-guard";

/** Optimizer-specific Nerd Font glyphs, matching pix-optimizer's catalog. */
const TOOL_GLYPH: Record<OptimizerTool, string> = {
	caveman: "\u{F0710}",
	rtk: "\u{F04E5}",
	ponytail: "\u{F0190}",
	t2s: "\u{F0AC}",
	"edit-guard": "\u{F132}",
};

export const OPTIMIZER_ICON = "\u{F0DAB}";

export function toolIcon(tool: OptimizerTool): string {
	return TOOL_GLYPH[tool];
}

const TOOL_ORDER: readonly OptimizerTool[] = ["caveman", "rtk", "ponytail", "t2s", "edit-guard"];
const ENABLED_COLOR: ThemeColor = "accent";
const DISABLED_COLOR: ThemeColor = "dim";

export type Colorize = (color: ThemeColor, text: string) => string;

export function renderStatus(
	states: Partial<Record<OptimizerTool, boolean>>,
	color: Colorize,
): string {
	return `${TOOL_ORDER.map(tool => color(states[tool] === true ? ENABLED_COLOR : DISABLED_COLOR, toolIcon(tool))).join("  ")} `;
}

export class OptimizerStatus {
	#states: Partial<Record<OptimizerTool, boolean>> = {};
	// Status is repainted by each lifecycle context; no global icon listener is needed.

	get(tool: OptimizerTool): boolean | undefined {
		return this.#states[tool];
	}

	set(tool: OptimizerTool, enabled: boolean, ctx: Pick<ExtensionContext, "ui">): void {
		this.#states[tool] = enabled;
		this.paint(ctx);
	}

	paint(ctx: Pick<ExtensionContext, "ui">): void {
		const text = renderStatus(this.#states, (color, value) => ctx.ui.theme.fg(color, value));
		ctx.ui.setStatus(STATUS_KEY, text);
	}
}
