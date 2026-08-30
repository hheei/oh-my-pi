import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getMagicContextStorageDir, getProjectMagicContextDir } from "./data-path.ts";

const keys = ["NODE_ENV", "XDG_DATA_HOME", "MAGIC_CONTEXT_TEST_DATA_DIR", "OMP_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of keys) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

describe("getMagicContextStorageDir", () => {
	test("uses OMP agent dir", () => {
		delete process.env.NODE_ENV;
		delete process.env.XDG_DATA_HOME;
		delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		process.env.OMP_CODING_AGENT_DIR = "/tmp/omp-agent";
		expect(getMagicContextStorageDir()).toBe(path.join("/tmp/omp-agent", "extensions", "omp-mctx"));
	});

	test("defaults under ~/.omp/agent", () => {
		delete process.env.NODE_ENV;
		delete process.env.XDG_DATA_HOME;
		delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
		delete process.env.OMP_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		expect(getMagicContextStorageDir()).toBe(path.join(os.homedir(), ".omp", "agent", "extensions", "omp-mctx"));
	});
});

describe("getProjectMagicContextDir", () => {
	test("is under .omp not .pi", () => {
		expect(getProjectMagicContextDir("/repo")).toBe(path.join("/repo", ".omp", "magic-context"));
	});
});
