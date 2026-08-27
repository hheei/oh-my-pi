/** Persistence contract for optimizer values in the plugin lockfile. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createOptimizerStore, PLUGIN_NAME } from "./persist.ts";

let tmpDir: string | undefined;

function makeStore(lock?: Record<string, unknown>) {
	tmpDir = mkdtempSync(path.join(tmpdir(), "omp-optimizer-persist-test-"));
	const lockPath = path.join(tmpDir, "omp-plugins.lock.json");
	if (lock) writeFileSync(lockPath, JSON.stringify(lock));
	return { store: createOptimizerStore(lockPath), lockPath };
}

afterEach(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	tmpDir = undefined;
});

describe("optimizer persistence", () => {
	test("returns undefined before anything is saved", async () => {
		const { store } = makeStore();
		expect(await store.load("caveman")).toBeUndefined();
	});

	test("round-trips a value across fresh store instances", async () => {
		const { lockPath } = makeStore();
		await createOptimizerStore(lockPath).save("caveman", "lite");
		expect(await createOptimizerStore(lockPath).load("caveman")).toBe("lite");
	});

	test("persists each tool independently in one plugin settings object", async () => {
		const { store } = makeStore();
		await store.save("caveman", "lite");
		await store.save("ponytail", "full");
		await store.save("rtk", "off");
		await store.save("edit-guard", "off");
		expect(await store.load("caveman")).toBe("lite");
		expect(await store.load("ponytail")).toBe("full");
		expect(await store.load("rtk")).toBe("off");
		expect(await store.load("edit-guard")).toBe("off");
	});

	test("overwriting one tool leaves the others intact", async () => {
		const { store } = makeStore();
		await store.save("caveman", "lite");
		await store.save("ponytail", "full");
		await store.save("caveman", "ultra");
		expect(await store.load("caveman")).toBe("ultra");
		expect(await store.load("ponytail")).toBe("full");
	});

	test("preserves other plugins in the lockfile", async () => {
		const { store, lockPath } = makeStore({
			plugins: { "@other/plugin": { version: "1.0.0" } },
			settings: { "@other/plugin": { flag: true } },
			extra: 1,
		});
		await store.save("caveman", "lite");
		const raw = (await Bun.file(lockPath).json()) as Record<string, unknown>;
		expect(raw.extra).toBe(1);
		expect(raw.plugins).toEqual({ "@other/plugin": { version: "1.0.0" } });
		expect(raw.settings).toEqual({
			"@other/plugin": { flag: true },
			[PLUGIN_NAME]: { caveman: "lite" },
		});
	});

	test("drops unknown keys in this plugin's settings on the next write", async () => {
		const { store, lockPath } = makeStore({
			settings: { [PLUGIN_NAME]: { caveman: "lite", toon: "on" } },
		});
		await store.save("rtk", "on");
		expect(await Bun.file(lockPath).json()).toEqual({
			plugins: {},
			settings: {
				[PLUGIN_NAME]: { caveman: "lite", rtk: "on" },
			},
		});
	});

	test("creates a lockfile when none exists", async () => {
		const { store, lockPath } = makeStore();
		await store.save("caveman", "lite");
		expect(await Bun.file(lockPath).json()).toEqual({
			plugins: {},
			settings: { [PLUGIN_NAME]: { caveman: "lite" } },
		});
	});

	test("does not overwrite a corrupt lockfile", async () => {
		const { store, lockPath } = makeStore();
		writeFileSync(lockPath, "{not-json");
		await store.save("caveman", "lite");
		expect(readFileSync(lockPath, "utf8")).toBe("{not-json");
		expect(await store.load("caveman")).toBeUndefined();
	});

	test("does not overwrite a non-object lockfile", async () => {
		const { store, lockPath } = makeStore();
		writeFileSync(lockPath, "[]");
		await store.save("caveman", "lite");
		expect(readFileSync(lockPath, "utf8")).toBe("[]");
	});
});
