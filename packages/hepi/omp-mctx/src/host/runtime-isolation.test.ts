import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { closeDatabase, openDatabase, resolveDatabasePath } from "#core/features/storage-db";
import { getMagicContextStorageDir } from "#core/shared/data-path";
import magicContextPiExtension, { __test } from "../index.ts";
import { shouldStartOmpMctx } from "./settings.ts";

const CORTEXKIT_DB = join(homedir(), ".local/share/cortexkit/magic-context/context.db");
const HEPI_PI_DB = join(homedir(), ".pi/agent/extensions/pi-mctx/context.db");
const savedEnv = {
	NODE_ENV: process.env.NODE_ENV,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
	MAGIC_CONTEXT_TEST_DATA_DIR: process.env.MAGIC_CONTEXT_TEST_DATA_DIR,
	OMP_CODING_AGENT_DIR: process.env.OMP_CODING_AGENT_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

function fingerprint(path: string): { exists: boolean; ino: number; size: number } {
	if (!existsSync(path)) return { exists: false, ino: 0, size: 0 };
	const st = statSync(path);
	return { exists: true, ino: st.ino, size: st.size };
}

function createCountingPi() {
	const events: string[] = [];
	const tools: string[] = [];
	const commands: string[] = [];
	const pi = {
		on: (event: string) => {
			events.push(event);
		},
		registerTool: (tool: { name?: string }) => {
			tools.push(tool.name ?? "<unnamed>");
		},
		registerFlag: () => {},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		registerEntryRenderer: () => {},
		registerMessageRenderer: () => {},
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
	} as unknown as ExtensionAPI;
	return { pi, events, tools, commands };
}

afterEach(() => {
	closeDatabase();
	__test.clearPiMagicContextActive();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("omp-mctx storage isolation", () => {
	test("production dir is omp-mctx, not CortexKit or HEPI pi-mctx", () => {
		delete process.env.XDG_DATA_HOME;
		delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
		delete process.env.OMP_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.NODE_ENV;
		expect(getMagicContextStorageDir()).toBe(
			join(homedir(), ".omp", "agent", "extensions", "omp-mctx"),
		);
		expect(getMagicContextStorageDir()).not.toContain("cortexkit");
		expect(getMagicContextStorageDir()).not.toContain("pi-mctx");
		expect(getMagicContextStorageDir()).not.toContain("magic-context");
	});

	test("test isolation path is extensions/omp-mctx", () => {
		const root = mkdtempSync(join(tmpdir(), "omp-mctx-iso-"));
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
		delete process.env.XDG_DATA_HOME;
		const { dbDir, dbPath } = resolveDatabasePath();
		expect(dbDir).toBe(join(root, "extensions", "omp-mctx"));
		expect(dbPath).toBe(join(root, "extensions", "omp-mctx", "context.db"));
		expect(dbPath).not.toBe(CORTEXKIT_DB);
		expect(dbPath).not.toBe(HEPI_PI_DB);
	});

	test("openDatabase creates a private schema and does not touch upstream files", () => {
		const root = mkdtempSync(join(tmpdir(), "omp-mctx-db-"));
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
		delete process.env.XDG_DATA_HOME;
		const beforeCortex = fingerprint(CORTEXKIT_DB);
		const beforeHepi = fingerprint(HEPI_PI_DB);

		const db = openDatabase();
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((row) => row.name);
		expect(names).toContain("session_meta");
		expect(names).toContain("lkg_slots");
		expect(names).not.toContain("schema_migrations");

		const { dbPath } = resolveDatabasePath();
		expect(existsSync(dbPath)).toBe(true);
		expect(dbPath.startsWith(root)).toBe(true);

		expect(fingerprint(CORTEXKIT_DB)).toEqual(beforeCortex);
		expect(fingerprint(HEPI_PI_DB)).toEqual(beforeHepi);
	});
});

describe("omp-mctx factory", () => {
	test("enabled=false skips runtime and does not open a store", async () => {
		expect(shouldStartOmpMctx({ enabled: false })).toBe(false);
		const root = mkdtempSync(join(tmpdir(), "omp-mctx-gate-"));
		process.env.OMP_CODING_AGENT_DIR = root;
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
		delete process.env.XDG_DATA_HOME;
		const beforeCortex = fingerprint(CORTEXKIT_DB);
		const { pi, events, tools } = createCountingPi();
		await magicContextPiExtension(pi);
		expect(events).toEqual([]);
		expect(tools).toEqual([]);
		expect(existsSync(join(root, "extensions", "omp-mctx", "context.db"))).toBe(false);
		expect(fingerprint(CORTEXKIT_DB)).toEqual(beforeCortex);
	});
});
