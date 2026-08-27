import { describe, expect, test } from "bun:test";
import type { CustomEditor, SlashCommandInfo } from "@oh-my-pi/pi-coding-agent";
import { createPercentAtomicEditor } from "./atomic-editor";

const commands: SlashCommandInfo[] = [
	{ name: "skill:reader", source: "skill", path: "/skills/reader/SKILL.md", description: "Read", location: "user" },
];

function fakeEditor(text: string, col: number): CustomEditor {
	let line = text;
	let cursor = col;
	let pattern: RegExp | undefined;
	const editor = {
		get atomicTokenPattern() {
			return pattern;
		},
		set atomicTokenPattern(value: RegExp | undefined) {
			pattern = value;
		},
		getLines: () => [line],
		getCursor: () => ({ line: 0, col: cursor }),
		handleInput(data: string) {
			if (data === "\x7f") {
				if (pattern) {
					pattern.lastIndex = 0;
					for (const match of line.matchAll(pattern)) {
						const start = match.index ?? 0;
						const end = start + match[0].length;
						if (cursor - 1 >= start && cursor - 1 < end) {
							line = line.slice(0, start) + line.slice(end);
							cursor = start;
							return;
						}
					}
				}
				if (cursor > 0) {
					line = line.slice(0, cursor - 1) + line.slice(cursor);
					cursor -= 1;
				}
			}
			if (data === "\x1b[3~") {
				if (pattern) {
					pattern.lastIndex = 0;
					for (const match of line.matchAll(pattern)) {
						const start = match.index ?? 0;
						const end = start + match[0].length;
						if (cursor >= start && cursor < end) {
							line = line.slice(0, start) + line.slice(end);
							cursor = start;
							return;
						}
					}
				}
				if (cursor < line.length) {
					line = line.slice(0, cursor) + line.slice(cursor + 1);
				}
			}
		},
	};
	return editor as unknown as CustomEditor;
}

describe("percent atomic editor", () => {
	test("backspace deletes the whole token and leaves neighbors", () => {
		const editor = fakeEditor("x %reader y", 6);
		createPercentAtomicEditor(editor, () => commands, () => true);
		editor.handleInput("\x7f");
		expect(editor.getLines()[0]).toBe("x  y");
		expect(editor.getCursor().col).toBe(2);
	});
	test("delete deletes the whole token and leaves neighbors", () => {
		const editor = fakeEditor("x %reader y", 2);
		createPercentAtomicEditor(editor, () => commands, () => true);
		editor.handleInput("\x1b[3~");
		expect(editor.getLines()[0]).toBe("x  y");
		expect(editor.getCursor().col).toBe(2);
	});
});
