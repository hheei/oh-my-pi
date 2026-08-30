import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { closeDatabase, openDatabaseAsync } from "#core/features/storage-db";
import { DURABLE_MEMORY_TABLES } from "#core/features/fresh-schema";
import { Database } from "#core/shared/sqlite";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { getMagicContextStorageDir } from "#core/shared/data-path";
import { setBootQuietPeriodForTests } from "#core/plugin/boot-quiet";
import magicContextPiExtension, { __test } from "../index.ts";
import { __setOmpMctxPluginSettingsForTests } from "./settings.ts";

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
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		on: (event: string, handler?: (event: unknown, ctx: unknown) => unknown) => {
			events.push(event);
			if (handler) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			}
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
	return { pi, events, tools, commands, handlers };
}

afterEach(() => {
	closeDatabase();
	__test.clearPiMagicContextActive();
	__setOmpMctxPluginSettingsForTests(null);
	setBootQuietPeriodForTests(null);
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("omp-mctx enabled factory smoke", () => {
	test("starts runtime, registers context/tools, writes isolated context.db", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-mctx-enable-"));
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
		process.env.OMP_CODING_AGENT_DIR = root;
		delete process.env.XDG_DATA_HOME;
		delete process.env.PI_CODING_AGENT_DIR;
		__setOmpMctxPluginSettingsForTests({
			enabled: true,
			memoryEnabled: false,
			dreamerEnabled: false,
			historianEnabled: false,
		});
		const beforeCortex = fingerprint(CORTEXKIT_DB);
		const beforeHepi = fingerprint(HEPI_PI_DB);
		const { pi, events, tools, commands, handlers } = createCountingPi();

		await magicContextPiExtension(pi);

		const dbPath = join(root, "extensions", "omp-mctx", "context.db");
		expect(existsSync(dbPath)).toBe(true);
		expect(events).toContain("context");
		expect(tools).toContain("ctx_search");
		expect(tools).toContain("ctx_note");
		expect(tools).not.toContain("ctx_memory");
		expect(commands).not.toContain("ctx-embed");
		expect(commands.length).toBeGreaterThan(0);

		const contextHandler = handlers.get("context")?.[0];
		if (typeof contextHandler !== "function") {
			throw new Error("context handler was not registered");
		}
		const result = await contextHandler(
			{
				messages: [{ role: "user", content: "smoke ping", timestamp: 1 }],
			},
			{
				cwd: root,
				model: { provider: "openai", contextWindow: 128_000 },
				sessionManager: {
					getSessionId: () => "omp-mctx-enable-smoke",
					getBranch: () => [],
					getLeafId: () => undefined,
					getEntry: () => undefined,
				},
			},
		);
		expect(result).toBeDefined();
		expect(result).toBeTypeOf("object");
		if (!result || typeof result !== "object" || !("messages" in result) || !Array.isArray(result.messages)) {
			throw new Error(`context handler fail-opened: ${String(result)}`);
		}
		const messages = result.messages;
		expect(messages.length).toBeGreaterThanOrEqual(1);
		const first = messages[0] as { role?: string; content?: unknown };
		expect(first.role).toBe("user");
		const text =
			typeof first.content === "string"
				? first.content
				: Array.isArray(first.content)
					? first.content
							.map((part) =>
								part && typeof part === "object" && "text" in part && typeof part.text === "string"
									? part.text
									: "",
							)
							.join("\n")
					: "";
		expect(text).toContain("<session-history>");
		const inspectionDb = new Database(dbPath);
		try {
			const schemaObjects = inspectionDb
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' OR type = 'view'")
				.all() as Array<{ name: string }>;
			for (const table of DURABLE_MEMORY_TABLES) {
				expect(schemaObjects.some(({ name }) => name === table || name.startsWith(`${table}_`))).toBe(false);
			}
		} finally {
			closeQuietly(inspectionDb);
		}

		expect(fingerprint(CORTEXKIT_DB)).toEqual(beforeCortex);
		expect(fingerprint(HEPI_PI_DB)).toEqual(beforeHepi);
	});


	test("omits ctx_search and ctx_note while retaining core Window controls", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-mctx-tools-disabled-"));
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
		process.env.OMP_CODING_AGENT_DIR = root;
		delete process.env.XDG_DATA_HOME;
		delete process.env.PI_CODING_AGENT_DIR;
		__setOmpMctxPluginSettingsForTests({
			enabled: true,
			memoryEnabled: false,
			searchEnabled: false,
			noteEnabled: false,
			dreamerEnabled: false,
			historianEnabled: false,
		});
		const { pi, tools, events } = createCountingPi();

		await magicContextPiExtension(pi);

		expect(events).toContain("context");
		expect(tools).not.toContain("ctx_search");
		expect(tools).not.toContain("ctx_note");
		expect(tools).not.toContain("ctx_memory");
		expect(tools).toContain("ctx_expand");
		expect(tools).toContain("ctx_reduce");
	});

	test("registers search and note independently", async () => {
		const cases = [
			{ searchEnabled: false, noteEnabled: true, absent: "ctx_search", present: "ctx_note" },
			{ searchEnabled: true, noteEnabled: false, absent: "ctx_note", present: "ctx_search" },
		] as const;
		for (const toolCase of cases) {
			const root = mkdtempSync(join(tmpdir(), "omp-mctx-tool-combination-"));
			process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
			process.env.OMP_CODING_AGENT_DIR = root;
			delete process.env.XDG_DATA_HOME;
			delete process.env.PI_CODING_AGENT_DIR;
			__setOmpMctxPluginSettingsForTests({
				enabled: true,
				memoryEnabled: false,
				searchEnabled: toolCase.searchEnabled,
				noteEnabled: toolCase.noteEnabled,
				dreamerEnabled: false,
				historianEnabled: false,
			});
			const { pi, tools } = createCountingPi();

			await magicContextPiExtension(pi);

			expect(tools).not.toContain(toolCase.absent);
			expect(tools).toContain(toolCase.present);
			expect(tools).toContain("ctx_expand");
			expect(tools).toContain("ctx_reduce");
			closeDatabase();
			__test.clearPiMagicContextActive();
			__setOmpMctxPluginSettingsForTests(null);
		}
	});
	test("registers legacy Memory only after explicit opt-in", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-mctx-memory-enable-"));
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
		process.env.OMP_CODING_AGENT_DIR = root;
		delete process.env.XDG_DATA_HOME;
		delete process.env.PI_CODING_AGENT_DIR;
		__setOmpMctxPluginSettingsForTests({
			enabled: true,
			memoryEnabled: true,
			dreamerEnabled: false,
			historianEnabled: false,
		});
		const { pi, tools, commands } = createCountingPi();

		await magicContextPiExtension(pi);

		expect(tools).toContain("ctx_memory");
		expect(commands).toContain("ctx-embed");
		const dbPath = join(root, "extensions", "omp-mctx", "context.db");
		const inspectionDb = new Database(dbPath);
		try {
			expect(
				inspectionDb
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
					.get(),
			).toBeDefined();
		} finally {
			closeQuietly(inspectionDb);
		}
	});

	test("fails closed without registering normal tools when its storage path is unavailable", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-mctx-storage-failure-"));
		const blockedPath = join(root, "not-a-directory");
		writeFileSync(blockedPath, "blocked");
		delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
		process.env.XDG_DATA_HOME = blockedPath;
		delete process.env.OMP_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		__setOmpMctxPluginSettingsForTests({
			enabled: true,
			memoryEnabled: false,
			dreamerEnabled: false,
			historianEnabled: false,
		});
		expect(getMagicContextStorageDir()).toBe(join(blockedPath, "extensions", "omp-mctx"));
		await expect(openDatabaseAsync()).rejects.toThrow("storage unavailable");
		const { pi, events, tools, commands } = createCountingPi();

		await magicContextPiExtension(pi);

		expect(events).toContain("context");
		expect(tools).toEqual([]);
		expect(commands).toEqual([]);
	});
});
