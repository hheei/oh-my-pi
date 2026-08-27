/** Interactive `/optimizer` command using OMP's native settings components. */

import { getSettingsListTheme } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	matchesKey,
	padding,
	SettingsList,
	truncateToWidth,
	type SettingItem,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { OptimizerHandle, OptimizerStatus, OptimizerTool } from "./status.ts";
import { OPTIMIZER_ICON, toolIcon } from "./status.ts";

const TOOL_ORDER: readonly OptimizerTool[] = ["caveman", "rtk", "ponytail", "t2s", "edit-guard"];

function helpSummary(help: string): string {
	const dash = help.indexOf("—");
	return dash === -1 ? help : help.slice(dash + 1).trim();
}

export function buildOptHelp(handles: Record<OptimizerTool, OptimizerHandle>): string {
	const lines = TOOL_ORDER.map(tool => `  ${tool}: ${handles[tool].current()} — ${helpSummary(handles[tool].help)}`);
	return ["omp-optimizer — token tools", "", ...lines].join("\n");
}

function displayName(tool: OptimizerTool): string {
	return tool.split("-").map(part => `${part[0]?.toUpperCase()}${part.slice(1)}`).join(" ");
}

function buildItems(handles: Record<OptimizerTool, OptimizerHandle>): SettingItem[] {
	return TOOL_ORDER.map(tool => ({
		id: tool,
		label: `${toolIcon(tool)}  ${displayName(tool)}`,
		description: helpSummary(handles[tool].help),
		currentValue: handles[tool].current(),
		values: [...handles[tool].values],
	}));
}

function normalizeSettingsKey(data: string): string {
	if (matchesKey(data, "up")) return "\u001b[A";
	if (matchesKey(data, "down")) return "\u001b[B";
	if (matchesKey(data, "escape")) return "\u001b";
	if (matchesKey(data, "space")) return " ";
	if (matchesKey(data, "enter")) return "\n";
	return data;
}

function trimSettingsListPadding(rows: readonly string[]): string[] {
	const footerIndex = rows.findLastIndex(row => row !== "");
	if (footerIndex < 0) return [...rows];
	const content = rows.slice(0, footerIndex);
	while (content.at(-1) === "") content.pop();
	return [...content, "", rows[footerIndex]!];
}

function fitLine(text: string, width: number): string {
	const innerWidth = Math.max(0, width - 4);
	const clipped = truncateToWidth(text, innerWidth);
	return `${clipped}${padding(Math.max(0, innerWidth - visibleWidth(clipped)))}`;
}

function frameRow(text: string, width: number, theme: Theme): string {
	const border = (value: string) => theme.fg("border", value);
	return `${border(theme.boxRound.vertical)} ${fitLine(text, width)} ${border(theme.boxRound.vertical)}`;
}

function topBorder(width: number, title: string, theme: Theme): string {
	const border = (value: string) => theme.fg("border", value);
	const inner = Math.max(0, width - 2);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return `${border(theme.boxRound.topLeft + theme.boxRound.horizontal)}${theme.bold(theme.fg("accent", shown))}${border(theme.boxRound.horizontal.repeat(fillWidth) + theme.boxRound.topRight)}`;
}

function bottomBorder(width: number, theme: Theme): string {
	const border = (value: string) => theme.fg("border", value);
	return border(
		theme.boxRound.bottomLeft + theme.boxRound.horizontal.repeat(Math.max(0, width - 2)) + theme.boxRound.bottomRight,
	);
}

class OptimizerPanel implements Component {
	#list: SettingsList;
	#tui: TUI;
	#done: (result: null) => void;
	#theme: Theme;

	constructor(
		tui: TUI,
		theme: Theme,
		handles: Record<OptimizerTool, OptimizerHandle>,
		ctx: ExtensionCommandContext,
		done: (result: null) => void,
	) {
		this.#theme = theme;
		this.#tui = tui;
		this.#done = done;
		this.#list = new SettingsList(
			buildItems(handles),
			Math.min(TOOL_ORDER.length, 8),
			getSettingsListTheme(),
			(id, value) => {
				void handles[id as OptimizerTool]?.run(value, ctx);
			},
			() => this.#done(null),
			{ typeToSearch: false, hint: "↑↓ move · Enter/Space change · Esc close" },
		);
	}

	render(width: number): readonly string[] {
		const rows = trimSettingsListPadding(this.#list.render(width));
		return [
			topBorder(width, `${OPTIMIZER_ICON}  Optimizer`, this.#theme),
			...rows.map(row => frameRow(row, width, this.#theme)),
			bottomBorder(width, this.#theme),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q")) {
			this.#done(null);
			return;
		}
		this.#list.handleInput(normalizeSettingsKey(data));
		this.#tui.requestRender();
	}

	invalidate(): void {
		this.#list.invalidate();
	}
}

export function registerOptCommand(
	pi: ExtensionAPI,
	handles: Record<OptimizerTool, OptimizerHandle>,
	_status: OptimizerStatus,
): void {
	pi.registerCommand("optimizer", {
		description: "Enable or disable optimizer modes",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(buildOptHelp(handles), "info");
				return;
			}
			await ctx.ui.custom<null>(
				(tui, theme, _keybindings, done) => new OptimizerPanel(tui, theme, handles, ctx, done),
				{
					overlay: true,
					// ponytail: default custom overlays are bottom-centered, leaving the
					// transcript-sized prompt area blank above this short panel.
					overlayOptions: { anchor: "top-center", offsetY: 5, width: "100%", maxHeight: "100%", margin: 0 },
				},
			);
		},
	});
}
