#!/usr/bin/env -S node --no-warnings --import jiti/register
/**
 * Live host smoke for `/handoff`.
 *
 *   npm run smoke:handoff --workspace=@hheei/pi-mctx -- [all|happy|cancel|resume|historian]
 *
 * Child-only modes used by resume:
 *   crash-after-snapshot, resume-continue
 */
import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionUIContext,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { getCompartments } from "../src/core/features/compartment-storage";
import { openDatabase } from "../src/core/features/storage";
import { getTagsBySession } from "../src/core/features/storage-tags";
import {
	HANDOFF_ATTEMPT_TYPE,
	HANDOFF_CONTEXT_TYPE,
	HANDOFF_REQUEST_TYPE,
} from "../src/handoff/model";
import magicContext from "../src/index";

const USER_AGENT_DIR = join(process.env.HOME ?? "/home/chlo", ".pi", "agent");
const PROVIDER = process.env.HANDOFF_SMOKE_PROVIDER ?? "cx";
const MODEL = process.env.HANDOFF_SMOKE_MODEL ?? "gpt-5.6-luna";
const HISTORIAN = process.env.HANDOFF_SMOKE_HISTORIAN ?? `${PROVIDER}/${MODEL}`;
const TIMEOUT_MS = 180_000;
const SCENARIO = process.argv[2] ?? process.env.HANDOFF_SMOKE_SCENARIO ?? "all";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const JITI_REGISTER = join(
	dirname(createRequire(import.meta.url).resolve("jiti/package.json")),
	"lib",
	"jiti-register.mjs",
);

type CustomEntry = {
	type?: string;
	id?: string;
	customType?: string;
	data?: { phase?: string; requestId?: string };
	content?: string | Array<{ type?: string; text?: string }>;
	details?: { requestId?: string };
	message?: { role?: string; customType?: string };
};

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function pass(message: string): void {
	console.log(`PASS ${message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionFiles(sessionsDir: string): string[] {
	if (!existsSync(sessionsDir)) return [];
	return readdirSync(sessionsDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => entry.name);
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
}

function runSmokeChild(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
	return waitForExit(
		spawn(process.execPath, ["--no-warnings", "--import", JITI_REGISTER, SCRIPT_PATH, ...args], {
			cwd: process.cwd(),
			env,
			stdio: "inherit",
		}),
	);
}

function stubTheme() {
	return {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
	};
}

function stubUi(options?: { tuiCancel?: { abort?: () => void } | undefined }): ExtensionUIContext {
	const noopAsync = async () => undefined;
	return {
		select: noopAsync,
		confirm: async () => false,
		input: noopAsync,
		notify(message: string, type?: "info" | "warning" | "error") {
			console.log(`[notify:${type ?? "info"}] ${message}`);
		},
		onTerminalInput: () => () => undefined,
		setStatus() {},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		custom: async (
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (value: unknown) => void,
			) => unknown,
		) => {
			const tui = { requestRender() {} };
			return await new Promise<unknown>((resolve, reject) => {
				if (options?.tuiCancel) {
					options.tuiCancel.abort = () => resolve({ status: "aborted" });
				}
				try {
					factory(tui, stubTheme(), {}, (value) => {
						resolve(value);
					});
				} catch (error) {
					reject(error);
				}
			});
		},
		pasteToEditor() {},
		setEditorText(text: string) {
			console.log(`[editor] ${JSON.stringify(text)}`);
		},
		getEditorText: () => "",
		editor: noopAsync,
		addAutocompleteProvider() {},
		setEditor() {},
		setEditorComponent() {},
		getEditorComponent: () => undefined,
		theme: stubTheme(),
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded() {},
		showOverlay() {
			return { close() {}, update() {} };
		},
		hideOverlay() {},
	} as unknown as ExtensionUIContext;
}

function seedConversation(session: AgentSession, count = 2): void {
	const now = Date.now();
	for (let index = 0; index < count; index++) {
		session.sessionManager.appendMessage({
			role: "user",
			content:
				index === 0
					? "Add a parsePort helper that accepts a string and returns a number or undefined."
					: `Also cover case ${index}: leading-zero and out-of-range ports in tests.`,
			timestamp: now + index * 2,
		} as never);
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{
					type: "text",
					text:
						index === 0
							? "Added parsePort in src/net.ts. It trims input, rejects empty values, and returns Number.parseInt with radix 10 when the whole string is digits."
							: `Added tests for case ${index}: '080', '0', '65536', and non-numeric input. parsePort('080') is undefined; 1..65535 remain valid.`,
				},
			],
			timestamp: now + index * 2 + 1,
			stopReason: "stop",
		} as never);
	}
}

function inspectSession(label: string, path: string | undefined): CustomEntry[] {
	if (!path || !existsSync(path)) {
		console.log(`${label}: <no file> ${path ?? ""}`);
		return [];
	}
	const opened = SessionManager.open(path);
	const entries = opened.getEntries() as CustomEntry[];
	console.log(`${label}: ${path}`);
	console.log(`  id=${opened.getSessionId()} entries=${entries.length}`);
	for (const entry of entries) {
		if (entry.type === "custom") {
			console.log(
				`  custom ${entry.customType} phase=${entry.data?.phase ?? "-"} request=${entry.data?.requestId ?? "-"}`,
			);
		} else if (entry.type === "custom_message") {
			console.log(`  custom_message ${entry.customType ?? "?"}`);
		} else if (entry.type === "message") {
			if (entry.message?.customType) {
				console.log(`  message customType=${entry.message.customType} role=${entry.message.role}`);
			} else {
				console.log(`  message role=${entry.message?.role ?? "?"}`);
			}
		} else {
			console.log(`  ${entry.type}`);
		}
	}
	return entries;
}

function requestEntries(entries: readonly CustomEntry[]): CustomEntry[] {
	return entries.filter(
		(entry) => entry.type === "custom" && entry.customType === HANDOFF_REQUEST_TYPE,
	);
}

function latestRequest(entries: readonly CustomEntry[]): CustomEntry | undefined {
	return requestEntries(entries).at(-1);
}

function destContexts(entries: readonly CustomEntry[]): CustomEntry[] {
	return entries.filter((entry) => {
		if (entry.type === "custom_message") return entry.customType === HANDOFF_CONTEXT_TYPE;
		return entry.type === "message" && entry.message?.customType === HANDOFF_CONTEXT_TYPE;
	});
}

function destAttempts(entries: readonly CustomEntry[]): CustomEntry[] {
	return entries.filter(
		(entry) => entry.type === "custom" && entry.customType === HANDOFF_ATTEMPT_TYPE,
	);
}

function contextText(entry: CustomEntry): string {
	if (typeof entry.content === "string") return entry.content;
	return entry.content?.find((part) => part.type === "text")?.text ?? "";
}

function prepareRoot(existing?: string): { root: string; agentDir: string; cwd: string } {
	const root = existing ?? mkdtempSync(join(tmpdir(), "pi-handoff-smoke-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "magic-context.log");
	if (!existsSync(join(agentDir, "auth.json"))) {
		copyFileSync(join(USER_AGENT_DIR, "auth.json"), join(agentDir, "auth.json"));
		try {
			copyFileSync(join(USER_AGENT_DIR, "models.json"), join(agentDir, "models.json"));
		} catch {
			console.warn("models.json not copied; relying on built-in + auth providers");
		}
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify(
				{
					defaultProvider: PROVIDER,
					defaultModel: MODEL,
					defaultThinkingLevel: "off",
					compaction: { enabled: false },
					"pi-mctx": {
						enabled: true,
						compactionEnabled: true,
						historianEnabled: true,
						historianModel: HISTORIAN,
						memoryEnabled: false,
						embeddingProvider: "off",
						dreamerEnabled: false,
					},
				},
				null,
				2,
			)}\n`,
		);
	}
	return { root, agentDir, cwd };
}

async function startRuntime(args: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	mode: "rpc" | "tui";
	tuiCancel?: { abort?: () => void } | undefined;
}) {
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: options.agentDir,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [magicContext],
			},
		});
		const model =
			services.modelRuntime.getModel(PROVIDER, MODEL) ??
			fail(`model ${PROVIDER}/${MODEL} not available`);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager ?? fail("runtime factory missing sessionManager"),
			sessionStartEvent: options.sessionStartEvent ?? {
				type: "session_start",
				reason: "startup",
			},
			model,
			thinkingLevel: "off",
		});
		return {
			...created,
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: args.cwd,
		agentDir: args.agentDir,
		sessionManager: args.sessionManager,
	});
	const ui = stubUi({ tuiCancel: args.tuiCancel });
	const bind = async (session: AgentSession) => {
		await session.bindExtensions({
			uiContext: ui,
			mode: args.mode,
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				switchSession: (path) => runtime.switchSession(path),
				fork: async (entryId, options) => {
					const result = await runtime.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async () => ({ cancelled: true }),
				reload: async () => undefined,
			},
		});
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	runtime.session.extensionRunner.onError((error) => {
		console.error(`[extension-error] ${error.extensionPath} ${error.event}: ${error.error}`);
	});
	const commandNames = runtime.session.extensionRunner
		.getRegisteredCommands()
		.map((command) => command.invocationName);
	if (!commandNames.includes("handoff")) fail("/handoff is not registered");
	return runtime;
}

async function withTimeout<T>(label: string, work: Promise<T>): Promise<T> {
	return await Promise.race([
		work,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
		}),
	]);
}

async function waitForRequestPhase(
	path: string,
	phase: string,
	timeoutMs = 120_000,
): Promise<CustomEntry> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(path)) {
			const latest = latestRequest(inspectQuiet(path));
			if (latest?.data?.phase === phase) return latest;
			if (
				latest?.data?.phase === "failed" ||
				latest?.data?.phase === "cancelled" ||
				latest?.data?.phase === "interrupted" ||
				latest?.data?.phase === "superseded"
			) {
				return latest;
			}
		}
		await sleep(150);
	}
	fail(`timed out waiting for phase ${phase} in ${path}`);
}

function inspectQuiet(path: string): CustomEntry[] {
	if (!existsSync(path)) return [];
	return SessionManager.open(path).getEntries() as CustomEntry[];
}

function assertHappyDestination(sourcePath: string, destPath: string | undefined): CustomEntry {
	const sourceEntries = inspectSession("SOURCE", sourcePath);
	const destEntries = inspectSession("DEST", destPath);
	const lastRequest = latestRequest(sourceEntries);
	if (!lastRequest) fail("source has no handoff request");
	if (lastRequest.data?.phase !== "replacement-started") {
		fail(
			`source last phase is ${lastRequest.data?.phase ?? "missing"}, expected replacement-started`,
		);
	}
	if (!destPath || destPath === sourcePath) fail("session was not replaced");
	const contexts = destContexts(destEntries);
	if (contexts.length !== 1) fail(`destination has ${contexts.length} handoff contexts`);
	if (destAttempts(destEntries).length === 0) fail("destination has no handoff attempt");
	const destContext = contexts[0];
	if (!destContext) fail("destination has no handoff context");
	const destText = contextText(destContext);
	if (!destText.includes("<handoff-context>")) fail("destination is missing handoff XML");
	if (!destText.includes("<handoff-summary>")) fail("destination is missing the handoff summary");
	if (destContext.details?.requestId !== lastRequest.data?.requestId) {
		fail("destination request id does not match the source request");
	}
	const header = SessionManager.open(destPath).getHeader();
	if (header?.parentSession !== sourcePath) {
		fail(`dest parent is ${header?.parentSession ?? "missing"}`);
	}
	console.log(`dest parent=${header?.parentSession}`);
	console.log(`request ${lastRequest.data?.requestId}`);
	return destContext;
}

async function runHappy(root?: string): Promise<{
	root: string;
	destPath: string;
	destId: string;
	destSessionId: string;
	runtime: Awaited<ReturnType<typeof startRuntime>>;
}> {
	const prepared = prepareRoot(root);
	console.log(`\n== happy ==\nsmoke root ${prepared.root}`);
	console.log(`model ${PROVIDER}/${MODEL} historian ${HISTORIAN}`);
	const sessionManager = SessionManager.create(prepared.cwd, join(prepared.agentDir, "sessions"));
	const sourcePath = sessionManager.getSessionFile() ?? fail("source session did not persist");
	const runtime = await startRuntime({
		cwd: prepared.cwd,
		agentDir: prepared.agentDir,
		sessionManager,
		mode: "rpc",
	});
	seedConversation(runtime.session);
	console.log(`source ${sourcePath}`);
	console.log("running /handoff");
	const started = Date.now();
	await withTimeout("happy /handoff", runtime.session.prompt("/handoff"));
	console.log(`elapsed ${Date.now() - started}ms`);
	const destPath = runtime.session.sessionFile ?? fail("missing dest path");
	const destContext = assertHappyDestination(sourcePath, destPath);
	const destId = destContext.id ?? fail("handoff context has no id");
	const destSessionId =
		runtime.session.sessionManager.getSessionId() ?? fail("dest session has no id");
	pass("happy");
	return { root: prepared.root, destPath, destId, destSessionId, runtime };
}

async function runHistorian(
	runtime: Awaited<ReturnType<typeof startRuntime>>,
	destId: string,
	destSessionId: string,
): Promise<void> {
	console.log("\n== historian ==");
	seedConversation(runtime.session, 8);
	console.log("running /ctx-wrapup 5 on destination");
	await withTimeout("dest /ctx-wrapup", runtime.session.prompt("/ctx-wrapup 5"));
	const db = openDatabase() ?? fail("could not open magic-context db");
	const tags = getTagsBySession(db, destSessionId);
	const leaked = tags.filter(
		(tag) => tag.messageId === destId || tag.messageId.startsWith(`${destId}:`),
	);
	console.log(`dest tags=${tags.length} leaked=${leaked.length} handoffId=${destId}`);
	if (leaked.length > 0) {
		fail(
			`destination historian tagged Handoff Context: ${leaked
				.map((tag) => `${tag.type}#${tag.tagNumber}:${tag.messageId}`)
				.join(", ")}`,
		);
	}
	const compartments = getCompartments(db, destSessionId);
	console.log(`dest compartments=${compartments.length}`);
	if (compartments.length === 0) {
		fail("destination wrapup created no compartments");
	}
	pass("historian");
}

async function runCancel(): Promise<void> {
	const prepared = prepareRoot();
	console.log(`\n== cancel ==\nsmoke root ${prepared.root}`);
	const sessionManager = SessionManager.create(prepared.cwd, join(prepared.agentDir, "sessions"));
	const sourcePath = sessionManager.getSessionFile() ?? fail("source session did not persist");
	const tuiCancel: { abort?: () => void } = {};
	const runtime = await startRuntime({
		cwd: prepared.cwd,
		agentDir: prepared.agentDir,
		sessionManager,
		mode: "tui",
		tuiCancel,
	});
	seedConversation(runtime.session);
	console.log("running /handoff with Esc after snapshot-ready");
	const prompt = runtime.session.prompt("/handoff");
	const snapshot = waitForRequestPhase(sourcePath, "snapshot-ready").then(async (request) => {
		if (request.data?.phase !== "snapshot-ready") {
			fail(`expected snapshot-ready before cancel, got ${request.data?.phase ?? "missing"}`);
		}
		console.log("snapshot-ready; sending Esc");
		const started = Date.now();
		while (!tuiCancel.abort && Date.now() - started < 5_000) await sleep(50);
		if (!tuiCancel.abort) fail("TUI progress surface never opened");
		tuiCancel.abort();
		return request;
	});
	await withTimeout("cancel /handoff", Promise.all([prompt, snapshot]));
	const sourceEntries = inspectSession("SOURCE", sourcePath);
	const last = latestRequest(sourceEntries);
	if (last?.data?.phase !== "cancelled") {
		fail(`source last phase is ${last?.data?.phase ?? "missing"}, expected cancelled`);
	}
	if (runtime.session.sessionFile !== sourcePath) {
		fail(`cancel switched away from source to ${runtime.session.sessionFile}`);
	}
	const sessionsDir = join(prepared.agentDir, "sessions");
	const extra = sessionFiles(sessionsDir).filter((name) => !sourcePath.endsWith(name));
	if (extra.length > 0) fail(`cancel created extra sessions: ${extra.join(", ")}`);
	pass("cancel");
}

async function runResume(): Promise<void> {
	const prepared = prepareRoot();
	console.log(`\n== resume ==\nsmoke root ${prepared.root}`);
	const crashCode = await runSmokeChild(["crash-after-snapshot"], {
		...process.env,
		HANDOFF_SMOKE_ROOT: prepared.root,
		HANDOFF_SMOKE_PROVIDER: PROVIDER,
		HANDOFF_SMOKE_MODEL: MODEL,
		HANDOFF_SMOKE_HISTORIAN: HISTORIAN,
	});
	if (crashCode !== 99) fail(`crash child exited ${crashCode}, expected 99`);
	const recorded = join(prepared.root, "source-path.txt");
	const recordedPath = existsSync(recorded) ? (await readFile(recorded, "utf8")).trim() : undefined;
	const crashedSource =
		recordedPath && existsSync(recordedPath)
			? recordedPath
			: findSourceWithPhase(prepared.agentDir, "snapshot-ready");
	if (!crashedSource) fail("crash child did not leave a snapshot-ready source");
	const crashed = latestRequest(inspectSession("CRASHED", crashedSource));
	if (crashed?.data?.phase !== "snapshot-ready") {
		fail(`crash left phase ${crashed?.data?.phase ?? "missing"}`);
	}
	const requestId = crashed.data?.requestId ?? fail("crash request missing id");
	const db = openDatabase() ?? fail("could not open magic-context db");
	db.prepare("DELETE FROM handoff_lease").run();
	console.log("expired crash lease; reloading source");
	const sessionManager = SessionManager.open(crashedSource);
	const runtime = await startRuntime({
		cwd: prepared.cwd,
		agentDir: prepared.agentDir,
		sessionManager,
		mode: "rpc",
	});
	if (runtime.session.sessionFile !== crashedSource) {
		fail(`session_start switched away from source to ${runtime.session.sessionFile}`);
	}
	const before = latestRequest(inspectQuiet(crashedSource));
	if (before?.data?.phase !== "snapshot-ready") {
		fail(`reload changed phase to ${before?.data?.phase ?? "missing"}`);
	}
	console.log("running /handoff to resume");
	const started = Date.now();
	await withTimeout("resume /handoff", runtime.session.prompt("/handoff"));
	console.log(`resume elapsed ${Date.now() - started}ms`);
	const destPath = runtime.session.sessionFile ?? fail("resume did not replace");
	const destContext = assertHappyDestination(crashedSource, destPath);
	if (destContext.details?.requestId !== requestId) {
		fail(`resume used request ${destContext.details?.requestId}, expected ${requestId}`);
	}
	pass("resume");
}

function findSourceWithPhase(agentDir: string, phase: string): string | undefined {
	const sessionsDir = join(agentDir, "sessions");
	for (const name of sessionFiles(sessionsDir)) {
		const path = join(sessionsDir, name);
		const latest = latestRequest(inspectQuiet(path));
		if (latest?.data?.phase === phase) return path;
	}
	return undefined;
}

async function runCrashAfterSnapshot(): Promise<void> {
	const prepared = prepareRoot(process.env.HANDOFF_SMOKE_ROOT);
	const sessionManager = SessionManager.create(prepared.cwd, join(prepared.agentDir, "sessions"));
	const sourcePath = sessionManager.getSessionFile() ?? fail("source session did not persist");
	writeFileSync(join(prepared.root, "source-path.txt"), sourcePath);
	const runtime = await startRuntime({
		cwd: prepared.cwd,
		agentDir: prepared.agentDir,
		sessionManager,
		mode: "rpc",
	});
	seedConversation(runtime.session);
	console.log(`crash source ${sourcePath}`);
	void runtime.session.prompt("/handoff");
	const request = await waitForRequestPhase(sourcePath, "snapshot-ready");
	if (request.data?.phase !== "snapshot-ready") {
		fail(`crash child saw ${request.data?.phase ?? "missing"}`);
	}
	console.log("snapshot-ready; crashing before completion");
	process.exit(99);
}

async function spawnScenario(name: string): Promise<void> {
	const code = await runSmokeChild([name], {
		...process.env,
		HANDOFF_SMOKE_PROVIDER: PROVIDER,
		HANDOFF_SMOKE_MODEL: MODEL,
		HANDOFF_SMOKE_HISTORIAN: HISTORIAN,
	});
	if (code !== 0) fail(`scenario ${name} exited ${code}`);
}

async function main(): Promise<void> {
	if (process.argv.includes("--print")) {
		const piCli = join(
			dirname(SCRIPT_PATH),
			"..",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"dist",
			"cli.js",
		);
		if (!existsSync(piCli)) {
			fail(`Pi CLI is missing from the pi-mctx development dependency: ${piCli}`);
		}
		const forwarded = process.argv.slice(process.argv.indexOf("--print"));
		const child = spawn(process.execPath, [piCli, ...forwarded], {
			stdio: "inherit",
			env: process.env,
		});
		process.exit(await waitForExit(child));
	}
	if (SCENARIO === "crash-after-snapshot") {
		await runCrashAfterSnapshot();
		return;
	}
	if (SCENARIO === "happy") {
		await runHappy();
		return;
	}
	if (SCENARIO === "cancel") {
		await runCancel();
		return;
	}
	if (SCENARIO === "resume") {
		await runResume();
		return;
	}
	if (SCENARIO === "historian") {
		const happy = await runHappy();
		await runHistorian(happy.runtime, happy.destId, happy.destSessionId);
		return;
	}
	if (SCENARIO !== "all") fail(`unknown scenario ${SCENARIO}`);
	const happy = await runHappy();
	await runHistorian(happy.runtime, happy.destId, happy.destSessionId);
	await spawnScenario("cancel");
	await spawnScenario("resume");
	console.log("\nPASS all");
}

await main();
