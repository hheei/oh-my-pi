/** Persist optimizer values in the host plugin lockfile. */

import { getPluginsLockfile, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { OptimizerTool } from "./status.ts";

export const PLUGIN_NAME = "@hheei/omp-optimizer";

type OptimizerFileConfig = Partial<Record<OptimizerTool, string>>;

const OPTIMIZER_TOOLS: readonly OptimizerTool[] = ["caveman", "rtk", "ponytail", "t2s", "edit-guard"];

export interface OptimizerStore {
	load(tool: OptimizerTool): Promise<string | undefined>;
	save(tool: OptimizerTool, value: string): Promise<void>;
}

type LockfileSnapshot = { kind: "missing" } | { kind: "ok"; raw: Record<string, unknown> } | { kind: "unusable" };

function pickTools(raw: unknown): OptimizerFileConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const config: OptimizerFileConfig = {};
	for (const tool of OPTIMIZER_TOOLS) {
		const value = (raw as Record<string, unknown>)[tool];
		if (typeof value === "string") config[tool] = value;
	}
	return config;
}

function asObject(raw: unknown): Record<string, unknown> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	return raw as Record<string, unknown>;
}

async function readLockfile(filePath: string): Promise<LockfileSnapshot> {
	try {
		const raw: unknown = await Bun.file(filePath).json();
		const obj = asObject(raw);
		if (!obj) {
			logger.warn("omp-optimizer: plugin lockfile is not an object", { filePath });
			return { kind: "unusable" };
		}
		return { kind: "ok", raw: obj };
	} catch (error) {
		if (isEnoent(error)) return { kind: "missing" };
		logger.warn("omp-optimizer: failed to read persist file", { filePath, error: String(error) });
		return { kind: "unusable" };
	}
}

export function createOptimizerStore(lockPath: string): OptimizerStore {
	return {
		load: async (tool: OptimizerTool) => {
			const snapshot = await readLockfile(lockPath);
			if (snapshot.kind !== "ok") return undefined;
			return pickTools(asObject(snapshot.raw.settings)?.[PLUGIN_NAME])[tool];
		},
		save: async (tool: OptimizerTool, value: string) => {
			try {
				const snapshot = await readLockfile(lockPath);
				if (snapshot.kind === "unusable") return;
				const raw = snapshot.kind === "ok" ? snapshot.raw : {};
				const ours = pickTools(asObject(raw.settings)?.[PLUGIN_NAME]);
				const settings = { ...asObject(raw.settings), [PLUGIN_NAME]: { ...ours, [tool]: value } };
				await Bun.write(lockPath, JSON.stringify({ ...raw, plugins: raw.plugins ?? {}, settings }, null, 2));
			} catch (error) {
				logger.warn("omp-optimizer: failed to persist state", { tool, error: String(error) });
			}
		},
	};
}

export async function loadOptValue(tool: OptimizerTool): Promise<string | undefined> {
	return createOptimizerStore(getPluginsLockfile()).load(tool);
}

export async function saveOptValue(tool: OptimizerTool, value: string): Promise<void> {
	await createOptimizerStore(getPluginsLockfile()).save(tool, value);
}
