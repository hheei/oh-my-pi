/** Disk-backed persistence for optimizer values. */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import type { OptimizerTool } from "./status.ts";

type OptimizerFileConfig = Partial<Record<OptimizerTool, string>>;

const OPTIMIZER_TOOLS: readonly OptimizerTool[] = ["caveman", "rtk", "ponytail"];

export interface OptimizerStore {
	load(tool: OptimizerTool): string | undefined;
	save(tool: OptimizerTool, value: string): void;
}

export function createOptimizerStore(statePath: string): OptimizerStore {
	const readState = (): OptimizerFileConfig => {
		try {
			if (!fs.existsSync(statePath)) return {};
			const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

			const config: OptimizerFileConfig = {};
			for (const tool of OPTIMIZER_TOOLS) {
				const value = (raw as Record<string, unknown>)[tool];
				if (typeof value === "string") config[tool] = value;
			}
			return config;
		} catch {
			return {};
		}
	};

	return {
		load: (tool: OptimizerTool) => readState()[tool],
		save: (tool: OptimizerTool, value: string) => {
			try {
				fs.mkdirSync(path.dirname(statePath), { recursive: true });
				fs.writeFileSync(statePath, JSON.stringify({ ...readState(), [tool]: value }, null, 2), "utf8");
			} catch (error) {
				logger.warn("omp-optimizer: failed to persist state", { tool, error: String(error) });
			}
		},
	};
}

function defaultStore(): OptimizerStore {
	return createOptimizerStore(path.join(getAgentDir(), "optimizer.json"));
}

export function loadOptValue(tool: OptimizerTool): string | undefined {
	return defaultStore().load(tool);
}

export function saveOptValue(tool: OptimizerTool, value: string): void {
	defaultStore().save(tool, value);
}
