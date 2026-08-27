/** OMP-native SettingsList interaction tests for the /optimizer overlay. */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { registerOptCommand } from "./opt.ts";
import type { OptimizerHandle, OptimizerStatus, OptimizerTool } from "./status.ts";

const KEYS = {
	up: { legacy: "\u001b[A", kitty: "\u001b[1;1A" },
	down: { legacy: "\u001b[B", kitty: "\u001b[1;1B" },
	enter: { legacy: "\r", kitty: "\u001b[13u" },
	space: { legacy: " ", kitty: "\u001b[32u" },
	escape: { legacy: "\u001b", kitty: "\u001b[27u" },
	q: { legacy: "q", kitty: "\u001b[113u" },
} as const;

const ENCODINGS = ["legacy", "kitty"] as const;

interface Overlay {
	render(width: number): readonly string[];
	handleInput(data: string): void;
}

interface Driver {
	feed(data: string): void;
	runs(): Array<{ tool: string; value: string }>;
	rows(): readonly string[];
	closed(): boolean;
}

async function openOverlay(): Promise<Driver> {
	const runs: Array<{ tool: string; value: string }> = [];
	const makeHandle = (name: OptimizerTool, current: string, values: string[]): OptimizerHandle => {
		let value = current;
		return {
			name,
			help: `${name} — help`,
			values,
			current: () => value,
			run: async next => {
				value = next;
				runs.push({ tool: name, value: next });
			},
		};
	};
	const handles: Record<OptimizerTool, OptimizerHandle> = {
		caveman: makeHandle("caveman", "off", ["off", "lite", "full", "ultra", "micro"]),
		rtk: makeHandle("rtk", "off", ["off", "on"]),
		ponytail: makeHandle("ponytail", "off", ["off", "lite", "full", "ultra"]),
		t2s: makeHandle("t2s", "on", ["on", "off"]),
		"edit-guard": makeHandle("edit-guard", "on", ["on", "off"]),
	};

	let overlay: Overlay | undefined;
	let closed = false;
	let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (_name: string, spec: { handler: typeof commandHandler }) => {
			commandHandler = spec.handler;
		},
	} as unknown as ExtensionAPI;

	registerOptCommand(pi, handles, {} as OptimizerStatus);
	if (!commandHandler) throw new Error("/optimizer did not register");

	const ctx = {
		hasUI: true,
		ui: {
			notify: () => {},
			custom: async <T>(
				factory: (tui: { requestRender(): void }, theme: unknown, keybindings: unknown, done: (value: T) => void) => Overlay,
			): Promise<T | undefined> => {
				overlay = factory(
					{ requestRender: () => {} },
					{
						bold: (text: string) => text,
						fg: (_color: string, text: string) => text,
						boxRound: {
							topLeft: "╭",
							topRight: "╮",
							bottomLeft: "╰",
							bottomRight: "╯",
							horizontal: "─",
							vertical: "│",
						},
					},
					undefined,
					() => {
						closed = true;
					},
				);
				return undefined;
			},
		},
	} as unknown as ExtensionCommandContext;

	await commandHandler("", ctx);
	if (!overlay) throw new Error("overlay was not constructed");
	const component = overlay;
	return {
		feed: data => component.handleInput(data),
		runs: () => runs,
		closed: () => closed,
		rows: () => component.render(80),
	};
}

describe("/optimizer layout", () => {
	it("uses switch-style titled chrome with aligned rows", async () => {
		const rows = (await openOverlay()).rows();
		expect(rows).toHaveLength(11);
		expect(rows[0]).toMatch(/^╭─ .*Optimizer /);
		expect(rows[1]).toContain("Caveman");
		expect(rows[5]).toContain("Edit Guard");
		expect(rows[6]).toMatch(/^│\s+│$/);
		expect(rows[7]).toContain("help");
		expect(rows[8]).toMatch(/^│\s+│$/);
		expect(rows[9]).toContain("Esc close");
		expect(rows[10]).toMatch(/^╰─+╯$/);
	});
});

for (const encoding of ENCODINGS) {
	describe(`/optimizer SettingsList keys (${encoding})`, () => {
		it("moves with the OMP down binding and changes the selected tool", async () => {
			const driver = await openOverlay();
			driver.feed(KEYS.down[encoding]);
			driver.feed(KEYS.space[encoding]);
			expect(driver.runs()).toEqual([{ tool: "rtk", value: "on" }]);
		});

		it("wraps upward and changes the last tool", async () => {
			const driver = await openOverlay();
			driver.feed(KEYS.up[encoding]);
			driver.feed(KEYS.space[encoding]);
			expect(driver.runs()).toEqual([{ tool: "edit-guard", value: "off" }]);
		});

		it("uses Enter and Space to cycle the selected setting", async () => {
			const driver = await openOverlay();
			driver.feed(KEYS.space[encoding]);
			driver.feed(KEYS.enter[encoding]);
			expect(driver.runs()).toEqual([
				{ tool: "caveman", value: "lite" },
				{ tool: "caveman", value: "full" },
			]);
		});

		it("closes on OMP cancel or the optional q shortcut", async () => {
			const driver = await openOverlay();
			driver.feed(KEYS.escape[encoding]);
			expect(driver.closed()).toBe(true);

			const second = await openOverlay();
			second.feed(KEYS.q[encoding]);
			expect(second.closed()).toBe(true);
		});

		it("ignores an unbound key without changing optimizer state", async () => {
			const driver = await openOverlay();
			driver.feed("x");
			expect(driver.runs()).toEqual([]);
		});
	});
}
