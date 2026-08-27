import { CustomEditor, getPluginSettings, type ExtensionAPI, type KeybindingsManager, type SlashCommandInfo } from "@oh-my-pi/pi-coding-agent";
import type { EditorTheme, TUI } from "@oh-my-pi/pi-tui";
import { createPercentAtomicEditor } from "./atomic-editor.ts";
import { createPercentProvider, DEFAULT_CONFIG, expandPercentReferences, normalizeConfig, type PercentConfig } from "./model.ts";

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor;

export default function percentSkill(pi: ExtensionAPI): void {
	let config: PercentConfig = DEFAULT_CONFIG;
	let active = false;
	let installed: EditorFactory | undefined;
	let previous: EditorFactory | undefined;
	const commands = (): readonly SlashCommandInfo[] => pi.getCommands();
	const load = async (cwd: string) => {
		try {
			config = normalizeConfig(await getPluginSettings("@hheei/omp-enhance", cwd));
		} catch (error) {
			pi.logger.warn("Failed to load omp-enhance settings; using defaults", { error: String(error) });
			config = DEFAULT_CONFIG;
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		await load(ctx.cwd);
		active = true;
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider(current => createPercentProvider(current, commands, () => config));
		if (typeof ctx.ui.getEditorComponent !== "function" || typeof ctx.ui.setEditorComponent !== "function") return;
		const currentFactory = ctx.ui.getEditorComponent();
		previous = currentFactory;
		const wrapper: EditorFactory = (tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return createPercentAtomicEditor(editor, commands, () => active && config.enabled);
		};
		installed = wrapper;
		ctx.ui.setEditorComponent(wrapper);
	});
	pi.on("session_switch", async (_event, ctx) => load(ctx.cwd));
	pi.on("session_shutdown", async (_event, ctx) => {
		active = false;
		if (installed && ctx.ui.getEditorComponent() === installed) ctx.ui.setEditorComponent(previous);
		installed = undefined;
	});
	pi.on("input", event => {
		if (event.source !== "interactive" || !active || !config.enabled) return;
		const text = expandPercentReferences(event.text, commands());
		return text === undefined ? undefined : { text, ...(event.images ? { images: event.images } : {}) };
	});
}
