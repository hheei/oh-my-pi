/** Interactive `/optimizer` command using OMP's native settings components. */

import { getSettingsListTheme } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { type Component, matchesKey, SettingsList, type SettingItem, type TUI } from "@oh-my-pi/pi-tui";
import type { OptimizerHandle, OptimizerStatus, OptimizerTool } from "./status.ts";
import { OPTIMIZER_ICON, toolIcon } from "./status.ts";

const TOOL_ORDER: readonly OptimizerTool[] = ["caveman", "rtk", "ponytail"];

function helpSummary(help: string): string {
	const dash = help.indexOf("—");
	return dash === -1 ? help : help.slice(dash + 1).trim();
}

export function buildOptHelp(handles: Record<OptimizerTool, OptimizerHandle>): string {
	const lines = TOOL_ORDER.map(tool => `  ${tool}: ${handles[tool].current()} — ${helpSummary(handles[tool].help)}`);
	return ["omp-optimizer — token tools", "", ...lines].join("\n");
}

function buildItems(handles: Record<OptimizerTool, OptimizerHandle>): SettingItem[] {
	return TOOL_ORDER.map(tool => ({
		id: tool,
		label: `${toolIcon(tool)}  ${tool[0]?.toUpperCase()}${tool.slice(1)}`,
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
		const rows = this.#list.render(width);
		return [
			this.#theme.fg("accent", this.#theme.bold(`${OPTIMIZER_ICON}  Optimizer`)),
			"",
			...rows,
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
				{ overlay: true },
			);
		},
	});
}
