import { getPluginSettings } from "@oh-my-pi/pi-coding-agent";

export const OMP_MCTX_PLUGIN = "@hheei/omp-mctx";

let pluginSettingsForTests: Record<string, unknown> | null = null;

export function __setOmpMctxPluginSettingsForTests(settings: Record<string, unknown> | null): void {
	pluginSettingsForTests = settings;
}

export function shouldStartOmpMctx(settings: Record<string, unknown>): boolean {
	return settings.enabled === true;
}

export async function loadOmpMctxPluginSettings(cwd: string): Promise<Record<string, unknown>> {
	if (pluginSettingsForTests) return pluginSettingsForTests;
	try {
		return await getPluginSettings(OMP_MCTX_PLUGIN, cwd);
	} catch {
		return { enabled: false };
	}
}
