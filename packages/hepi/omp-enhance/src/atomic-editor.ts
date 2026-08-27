import { matchesKey } from "@oh-my-pi/pi-tui";
import type { CustomEditor, SlashCommandInfo } from "@oh-my-pi/pi-coding-agent";

const pattern = /(^|[\s([{])%([A-Za-z][A-Za-z0-9-]*)(?=$|[^A-Za-z0-9:-])/g;
type Action = "left" | "right" | "backspace" | "delete";

function span(line: string, col: number, action: Action, commands: readonly SlashCommandInfo[]) {
	const names = new Set(commands.filter(command => command.source === "skill").map(command => command.name.replace(/^skill:/, "")));
	for (const match of line.matchAll(pattern)) {
		const name = match[2];
		const start = (match.index ?? 0) + (match[1]?.length ?? 0);
		const end = start + name.length + 1;
		if (!names.has(name)) continue;
		if ((action === "left" && start < col && col <= end) || (action === "right" && start <= col && col < end) || (action === "backspace" && start < col && col <= end) || (action === "delete" && start <= col && col < end)) return { start, end };
	}
}

export function createPercentAtomicEditor(editor: CustomEditor, commands: () => readonly SlashCommandInfo[], enabled: () => boolean): CustomEditor {
	const handle = editor.handleInput.bind(editor);
	editor.handleInput = (data: string) => {
		if (!enabled()) return handle(data);
		const action: Action | undefined = matchesKey(data, "left") ? "left" : matchesKey(data, "right") ? "right" : matchesKey(data, "backspace") ? "backspace" : matchesKey(data, "delete") ? "delete" : undefined;
		const cursor = editor.getCursor();
		const found = action ? span(editor.getLines()[cursor.line] ?? "", cursor.col, action, commands()) : undefined;
		if (!found) return handle(data);
		const count = action === "left" ? cursor.col - found.start : action === "right" ? found.end - cursor.col : found.end - found.start;
		for (let i = 0; i < count; i++) handle(data);
	};
	return editor;
}
