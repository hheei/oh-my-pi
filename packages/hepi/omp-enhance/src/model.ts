import type { AutocompleteItem, AutocompleteProvider } from "@oh-my-pi/pi-tui";
import type { SlashCommandInfo } from "@oh-my-pi/pi-coding-agent";

export const DEFAULT_MAX_SUGGESTIONS = 50;
export const MAX_SUGGESTIONS = 50;
export type PercentConfig = { enabled: boolean; maxSuggestions: number };
export const DEFAULT_CONFIG: PercentConfig = { enabled: true, maxSuggestions: DEFAULT_MAX_SUGGESTIONS };

export function normalizeConfig(value: Record<string, unknown> | undefined): PercentConfig {
	const enabled = value?.enabled !== false;
	const raw = value?.maxSuggestions;
	const maxSuggestions = typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw)
		? Math.max(1, Math.min(MAX_SUGGESTIONS, raw))
		: DEFAULT_MAX_SUGGESTIONS;
	return { enabled, maxSuggestions };
}

function nameOf(command: SlashCommandInfo): string {
	return command.name.startsWith("skill:") ? command.name.slice(6) : command.name;
}
function skills(commands: readonly SlashCommandInfo[]): SlashCommandInfo[] {
	const seen = new Set<string>();
	return commands.filter(command => {
		const name = nameOf(command);
		if (command.source !== "skill" || !name || seen.has(name)) return false;
		seen.add(name);
		return true;
	});
}
export function extractPercentToken(lines: readonly string[], line: number, col: number): { query: string; prefix: string } | undefined {
	const before = (lines[line] ?? "").slice(0, col);
	const match = /(^|[\s([{])%([A-Za-z][A-Za-z0-9-]*|)$/.exec(before);
	if (!match) return undefined;
	const start = (match.index ?? 0) + (match[1]?.length ?? 0);
	return { query: match[2] ?? "", prefix: before.slice(start) };
}
export function getPercentSuggestions(commands: readonly SlashCommandInfo[], query: string, limit: number): AutocompleteItem[] {
	return skills(commands).filter(c => nameOf(c).toLowerCase().startsWith(query.toLowerCase())).sort((a,b) => nameOf(a).localeCompare(nameOf(b))).slice(0, limit).map(command => ({
		value: `%${nameOf(command)}`,
		label: nameOf(command),
		description: `${command.location ? `${command.location[0].toUpperCase()}${command.location.slice(1)} - ` : "Skill - "}${command.description?.trim() ?? ""}`.trim(),
	}));
}
export function expandPercentReferences(text: string, commands: readonly SlashCommandInfo[]): string | undefined {
	const paths = new Map(skills(commands).filter(c => c.path).map(c => [nameOf(c), c.path!]));
	let changed = false;
	const output = text.replace(/(^|[\s([{])%([A-Za-z][A-Za-z0-9-]*)(?=$|[^A-Za-z0-9:-])/g, (match, boundary: string, name: string) => {
		const path = paths.get(name);
		if (!path) return match;
		changed = true;
		return `${boundary}${path}`;
	});
	return changed ? output : undefined;
}
export function createPercentProvider(current: AutocompleteProvider, commands: () => readonly SlashCommandInfo[], config: () => PercentConfig): AutocompleteProvider {
	return {
		async getSuggestions(lines, line, col, signal) {
			const token = config().enabled ? extractPercentToken(lines, line, col) : undefined;
			if (!token) return current.getSuggestions(lines, line, col, signal);
			const items = getPercentSuggestions(commands(), token.query, config().maxSuggestions);
			return items.length ? { prefix: token.prefix, items } : current.getSuggestions(lines, line, col, signal);
		},
		applyCompletion(lines, line, col, item, prefix) {
			if (!prefix.startsWith("%") || !item.value.startsWith("%")) return current.applyCompletion(lines, line, col, item, prefix);
			const next = [...lines];
			const text = next[line] ?? "";
			const start = Math.max(0, col - prefix.length);
			const suffix = text.slice(col);
			const separator = suffix === "" || /^[A-Za-z0-9:-]/.test(suffix) ? " " : "";
			const insertion = `${item.value}${separator}`;
			next[line] = `${text.slice(0, start)}${insertion}${suffix}`;
			return { lines: next, cursorLine: line, cursorCol: start + insertion.length };
		},
		shouldTriggerFileCompletion(lines, line, col) {
			return config().enabled && extractPercentToken(lines, line, col) ? false : (current.shouldTriggerFileCompletion?.(lines, line, col) ?? true);
		},
	};
}
