import { beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_TAB_WIDTH } from "@oh-my-pi/pi-utils";
import { initTheme, theme } from "./theme/theme";
import { layoutTodoHudSpine } from "./todo-hud-spine";

beforeAll(async () => {
	await initTheme();
});

describe("layoutTodoHudSpine", () => {
	it("closes a single group with last-sibling glyphs and no extra row", () => {
		const { spineGlyphs, contentLines } = layoutTodoHudSpine([["Group", "task a", "task b"]], theme);
		expect(contentLines).toEqual(["Group", "task a", "task b"]);
		expect(spineGlyphs).toEqual([`${theme.tree.last} `, "   ", "   "]);
	});

	it("keeps a continuing sibling gutter only until the last group", () => {
		const { spineGlyphs, contentLines } = layoutTodoHudSpine(["A", ["B", "child"]], theme);
		expect(contentLines).toEqual(["A", "B", "child"]);
		expect(spineGlyphs).toEqual([`${theme.tree.branch} `, `${theme.tree.last} `, "   "]);
	});

	it("skips empty blocks so the last real group still closes", () => {
		const { spineGlyphs, contentLines } = layoutTodoHudSpine(["only", []], theme);
		expect(contentLines).toEqual(["only"]);
		expect(spineGlyphs).toEqual([`${theme.tree.last} `]);
	});

	it("replaces tabs in content so the HUD does not punch terminal holes", () => {
		const { contentLines } = layoutTodoHudSpine(["a\tb"], theme);
		expect(contentLines).toEqual([`a${" ".repeat(DEFAULT_TAB_WIDTH)}b`]);
	});
});
