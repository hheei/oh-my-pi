/** Persistence contract for optimizer values across fresh store instances. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createOptimizerStore } from "./persist.ts";

let tmpAgentDir: string;
let statePath: string;

beforeAll(() => {
	tmpAgentDir = mkdtempSync(path.join(tmpdir(), "omp-optimizer-persist-test-"));
	statePath = path.join(tmpAgentDir, "optimizer.json");
});

afterAll(() => {
	rmSync(tmpAgentDir, { recursive: true, force: true });
});

describe("optimizer persistence", () => {
	test("returns undefined before anything is saved", () => {
		expect(createOptimizerStore(statePath).load("caveman")).toBeUndefined();
	});

	test("round-trips a value across fresh store instances", () => {
		createOptimizerStore(statePath).save("caveman", "lite");
		expect(createOptimizerStore(statePath).load("caveman")).toBe("lite");
	});

	test("persists each tool independently in one shared file", () => {
		const store = createOptimizerStore(statePath);
		store.save("ponytail", "full");
		store.save("rtk", "off");
		expect(store.load("caveman")).toBe("lite");
		expect(store.load("ponytail")).toBe("full");
		expect(store.load("rtk")).toBe("off");
	});

	test("overwriting one tool leaves the others intact", () => {
		const store = createOptimizerStore(statePath);
		store.save("caveman", "ultra");
		expect(store.load("caveman")).toBe("ultra");
		expect(store.load("ponytail")).toBe("full");
	});

	test("drops legacy TOON state on the next write", () => {
		writeFileSync(statePath, JSON.stringify({ caveman: "lite", toon: "on" }));
		createOptimizerStore(statePath).save("rtk", "on");
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ caveman: "lite", rtk: "on" });
	});
});
