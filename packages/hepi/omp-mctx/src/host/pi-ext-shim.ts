/** Host-side stand-in for @hheei/pi-ext-core. Not a Pi settings UI. */

export type SettingValue = string | number | boolean | undefined;
export type SettingsState = Record<string, Record<string, SettingValue | undefined> | undefined>;
export type SettingField<T = SettingValue> = {
	name?: string;
	id?: string;
	label?: string;
	type: string;
	default?: T;
	defaultValue?: T;
	description?: string;
	parse?: (draft: string) => T;
	validate?: (value: T) => string | boolean | undefined;
};

export type SettingsProvider = {
	id?: string;
	title?: string;
	moduleName?: string;
	description?: string;
	storage?: unknown;
	groups?: unknown;
	fields?: unknown;
};

export type {
	EstimateTextTokens,
	PiContextUsageReading,
	PiContextUsageSource,
	PiPrefixTokens,
	PiPrefixTool,
	ResolvedPiContextUsage,
} from "./context-usage";
export { estimatePiPrefixTokens, estimateTextTokens, resolvePiContextUsage } from "./context-usage";

export type ToolTui = {
	frame: <T>(tool: T, _opts?: unknown) => T;
};

export type ExtensionLifecycleContext = {
	resources: { add: (name: string, dispose: () => void) => void };
};

export function getToolTui(_pi: unknown): ToolTui {
	return {
		frame: (tool) => tool,
	};
}

export function registerToolTuiTrace(_pi: unknown): void {}

export function createJsonFlatSectionSettingsStorage(_opts: { section: string; group: string }): unknown {
	return {};
}

export function getRuntimeSettingsRegistry(_pi: unknown): { replace: (provider: SettingsProvider) => () => void } {
	return {
		replace: () => () => {},
	};
}
