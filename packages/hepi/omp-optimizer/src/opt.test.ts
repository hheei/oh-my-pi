import { describe, expect, it } from "bun:test";
import { buildOptHelp } from "./opt.ts";
import type { OptimizerHandle, OptimizerTool } from "./status.ts";

/** Build a handle set with fixed current values + value lists. */
function fakeHandles(): Record<OptimizerTool, OptimizerHandle> {
	const mk = (name: OptimizerTool, current: string, values: string[]): OptimizerHandle => ({
		name,
		help: `${name} — ${name} help`,
		values,
		current: () => current,
		run: () => {},
	});
	return {
		caveman: mk("caveman", "full", ["off", "lite", "full", "ultra", "micro"]),
		rtk: mk("rtk", "on", ["off", "on"]),
		ponytail: mk("ponytail", "off", ["off", "lite", "full", "ultra"]),
		t2s: mk("t2s", "on", ["on", "off"]),
		"edit-guard": mk("edit-guard", "on", ["on", "off"]),
	};
}


describe("buildOptHelp", () => {
	it("lists every tool with its current value", () => {
		const help = buildOptHelp(fakeHandles());
		expect(help).toContain("caveman: full");
		expect(help).toContain("rtk: on");
		expect(help).not.toContain("toon");
		expect(help).toContain("ponytail: off");
		expect(help).toContain("edit-guard: on");
		expect(help).toContain("caveman help");
	});
});
