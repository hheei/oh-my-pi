import { describe, expect, it } from "bun:test";
import { OptimizerStatus, renderStatus, STATUS_KEY, toolIcon } from "./status.ts";

/** Tagging colorizer: <accent>X</accent> / <dim>X</dim> for assertions. */
const tag = (c: string, t: string) => `<${c}>${t}</${c}>`;

// Nerd Font glyphs are the extension's stable visual identity in OMP's TUI.
const CV = toolIcon("caveman");
const RK = toolIcon("rtk");
const PT = toolIcon("ponytail");
const T2S = toolIcon("t2s");
const EG = toolIcon("edit-guard");
describe("renderStatus", () => {
	it("shows ALL icons in order, accent when enabled", () => {
		expect(renderStatus({ caveman: true, rtk: true, ponytail: true, t2s: true, "edit-guard": true }, tag)).toBe(
			`<accent>${CV}</accent>  <accent>${RK}</accent>  <accent>${PT}</accent>  <accent>${T2S}</accent>  <accent>${EG}</accent> `,
		);
	});

	it("dims disabled tools but still shows them", () => {
		expect(renderStatus({ caveman: false, rtk: true, ponytail: true, t2s: true, "edit-guard": true }, tag)).toBe(
			`<dim>${CV}</dim>  <accent>${RK}</accent>  <accent>${PT}</accent>  <accent>${T2S}</accent>  <accent>${EG}</accent> `,
		);
	});

	it("all dim when nothing enabled (cell never empty)", () => {
		expect(renderStatus({}, tag)).toBe(`<dim>${CV}</dim>  <dim>${RK}</dim>  <dim>${PT}</dim>  <dim>${T2S}</dim>  <dim>${EG}</dim> `);
	});

	it("preserves fixed order regardless of insertion order", () => {
		expect(renderStatus({ ponytail: true, caveman: true }, tag)).toBe(
			`<accent>${CV}</accent>  <dim>${RK}</dim>  <accent>${PT}</accent>  <dim>${T2S}</dim>  <dim>${EG}</dim> `,
		);
	});

	it("uses the optimizer Nerd Font icon catalog", () => {
		expect([CV, RK, PT, T2S, EG]).toEqual(["\u{F0710}", "\u{F04E5}", "\u{F0190}", "\u{F0AC}", "\u{F132}"]);
	});
});

describe("OptimizerStatus", () => {
	/** Minimal ui stub capturing setStatus calls. */
	function fakeCtx() {
		const calls: { key: string; text: string }[] = [];
		return {
			calls,
			ui: {
				setStatus: (key: string, text: string | undefined) => calls.push({ key, text: text ?? "" }),
				theme: { fg: (c: string, t: string) => `<${c}>${t}</${c}>` },
			},
		} as const;
	}

	it("paints the shared key with per-icon accent/dim", () => {
		const status = new OptimizerStatus();
		const ctx = fakeCtx();
		status.set("rtk", true, ctx as never);
		const last = ctx.calls.at(-1);
		if (!last) throw new Error("no calls");
		expect(last.key).toBe(STATUS_KEY);
		// caveman + ponytail + edit guard still unset (dim), rtk accent.
		expect(last.text).toBe(`<dim>${CV}</dim>  <accent>${RK}</accent>  <dim>${PT}</dim>  <dim>${T2S}</dim>  <dim>${EG}</dim> `);
	});

	it("accumulates state across tools", () => {
		const status = new OptimizerStatus();
		const ctx = fakeCtx();
		status.set("caveman", true, ctx as never);
		status.set("ponytail", true, ctx as never);
		const last = ctx.calls.at(-1);
		if (!last) throw new Error("no calls");
		expect(last.text).toBe(`<accent>${CV}</accent>  <dim>${RK}</dim>  <accent>${PT}</accent>  <dim>${T2S}</dim>  <dim>${EG}</dim> `);
	});

	it("dims an icon when its tool toggles off (cell stays populated)", () => {
		const status = new OptimizerStatus();
		const ctx = fakeCtx();
		status.set("rtk", true, ctx as never);
		status.set("rtk", false, ctx as never);
		const last = ctx.calls.at(-1);
		if (!last) throw new Error("no calls");
		expect(last.text).toBe(`<dim>${CV}</dim>  <dim>${RK}</dim>  <dim>${PT}</dim>  <dim>${T2S}</dim>  <dim>${EG}</dim> `);
	});
});
