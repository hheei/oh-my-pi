import { describe, expect, test } from "bun:test";
import {
	loadPiConfig,
	primePiMctxConfigFromPluginSettings,
	resetPiMctxConfigForReload,
	resolvePiMctxToolSettings,
} from "./index.ts";

describe("loadPiConfig", () => {
	test("defaults Durable Memory off without Pi settings paths", () => {
		resetPiMctxConfigForReload();
		const config = loadPiConfig();
		expect(config.enabled).toBe(true);
		expect(config.memory.enabled).toBe(false);
		expect(config.memory.auto_promote).toBe(false);
		expect(config.memory.auto_search.enabled).toBe(false);
		expect(config.memory.git_commit_indexing.enabled).toBe(false);
	});

	test("enables all configured memory adjuncts only on explicit opt-in", () => {
		resetPiMctxConfigForReload();
		primePiMctxConfigFromPluginSettings({
			enabled: true,
			memoryEnabled: true,
			memoryAutoPromote: true,
			memoryAutoSearchEnabled: true,
			memoryGitCommitIndexingEnabled: true,
		});
		const config = loadPiConfig();
		expect(config.enabled).toBe(true);
		expect(config.memory.enabled).toBe(true);
		expect(config.memory.auto_promote).toBe(true);
		expect(config.memory.auto_search.enabled).toBe(true);
		expect(config.memory.git_commit_indexing.enabled).toBe(true);
	});

	test("keeps Window search and note tools independently configurable", () => {
		expect(resolvePiMctxToolSettings({})).toEqual({ searchEnabled: true, noteEnabled: true });
		expect(resolvePiMctxToolSettings({ searchEnabled: false, noteEnabled: false })).toEqual({
			searchEnabled: false,
			noteEnabled: false,
		});
	});
});
