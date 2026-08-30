import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ensurePiArtifactGitignore,
	getDataDir,
	getMagicContextHistorianDir,
	getMagicContextLogPath,
	getMagicContextStorageDir,
	getMagicContextTempDir,
	getProjectMagicContextDir,
	getProjectMagicContextHistorianDir,
} from "../../../src/core/shared/data-path";

const savedEnv = {
	NODE_ENV: process.env.NODE_ENV,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
	MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH,
};
const tempDirs: string[] = [];

afterEach(() => {
	if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = savedEnv.NODE_ENV;
	if (savedEnv.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedEnv.PI_CODING_AGENT_DIR;
	if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
	if (savedEnv.MAGIC_CONTEXT_LOG_PATH === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
	else process.env.MAGIC_CONTEXT_LOG_PATH = savedEnv.MAGIC_CONTEXT_LOG_PATH;
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.length = 0;
});

describe("data-path", () => {
	test("resolves production storage under Pi's extension root", () => {
		delete process.env.XDG_DATA_HOME;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.NODE_ENV;
		expect(getDataDir()).toBe(path.join(os.homedir(), ".local", "share"));
		expect(getMagicContextStorageDir()).toBe(
			path.join(os.homedir(), ".pi", "agent", "extensions", "pi-mctx"),
		);
	});

	test("honors Pi's configured agent directory", () => {
		delete process.env.NODE_ENV;
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
		process.env.XDG_DATA_HOME = "/tmp/mctx-data";
		expect(getDataDir()).toBe("/tmp/mctx-data");
		expect(getMagicContextStorageDir()).toBe("/tmp/pi-agent/extensions/pi-mctx");
	});

	test("resolves Pi temp, log, and historian paths", () => {
		delete process.env.MAGIC_CONTEXT_LOG_PATH;
		expect(getMagicContextTempDir()).toBe(path.join(os.tmpdir(), "pi", "magic-context"));
		expect(getMagicContextLogPath()).toBe(
			path.join(os.tmpdir(), "pi", "magic-context", "magic-context.log"),
		);
		expect(getMagicContextHistorianDir()).toBe(
			path.join(os.tmpdir(), "pi", "magic-context", "historian"),
		);
	});

	test("honors explicit log path", () => {
		process.env.MAGIC_CONTEXT_LOG_PATH = "/tmp/mctx.log";
		expect(getMagicContextLogPath()).toBe("/tmp/mctx.log");
	});

	test("keeps project artifacts under Pi's private .pi directory", () => {
		expect(getProjectMagicContextDir("/work/project")).toBe("/work/project/.pi/magic-context");
		expect(getProjectMagicContextHistorianDir("/work/project")).toBe(
			"/work/project/.pi/magic-context/historian",
		);
	});

	test("adds artifact gitignore guard once without overwriting entries", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mctx-path-"));
		tempDirs.push(directory);
		const piDir = path.join(directory, ".pi");
		const gitignore = path.join(piDir, ".gitignore");
		ensurePiArtifactGitignore(directory);
		expect(existsSync(gitignore)).toBe(true);
		expect(readFileSync(gitignore, "utf8")).toContain("magic-context/");
		ensurePiArtifactGitignore(directory);
		expect(readFileSync(gitignore, "utf8").match(/pi:magic-context/g)?.length).toBe(2);
	});

	test("preserves existing artifact gitignore entries", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mctx-path-"));
		tempDirs.push(directory);
		const piDir = path.join(directory, ".pi");
		const gitignore = path.join(piDir, ".gitignore");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(gitignore, "other/\n", "utf8");
		ensurePiArtifactGitignore(directory);
		expect(readFileSync(gitignore, "utf8")).toContain("other/\n");
	});
});
