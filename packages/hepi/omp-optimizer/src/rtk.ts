/**
 * Simple RTK Integration
 *
 * 1. Injects RTK system prompt (tells model to prefix commands with rtk)
 * 2. Rewrites bash commands via `rtk rewrite`, plus a bun-test overlay
 * 3. Falls back gracefully if rtk binary is missing
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { canExecute } from "./capability.ts";
import { loadOptValue, saveOptValue } from "./persist.ts";
import type { OptimizerHandle, OptimizerStatus } from "./status.ts";

/**
 * Minimal structural shape of the SDK `tool_call` event we care about.
 * Mirrors `BashToolCallEvent` from the SDK without importing it, so the
 * rewrite logic stays unit-testable with plain objects.
 */
export interface BashCallEvent {
	toolName: string;
	input: { command?: unknown };
}

/** Official `rtk rewrite` lookup. Undefined means RTK has no equivalent. */
export type RtkRewriteLookup = (
	command: string,
) => string | undefined | Promise<string | undefined>;

const RTK_REWRITE_TIMEOUT_MS = 3000;

/** `rtk rewrite`: 0/3 = rewritten, 1 = no equivalent, 2 = denied. */
export function parseRtkRewriteOutput(
	exitCode: number,
	stdout: string,
	original: string,
): string | undefined {
	if (exitCode === 1 || exitCode === 2) return undefined;
	if (exitCode !== 0 && exitCode !== 3) return undefined;
	const rewritten = stdout.trim();
	if (!rewritten || rewritten === original) return undefined;
	return rewritten;
}

const SINGLE_QUOTED_SHELL_VALUE = "'(?:'\\\\''|[^'])*'";
const ENV_ASSIGNMENT_VALUE = `(?:"[^"]*"|${SINGLE_QUOTED_SHELL_VALUE}|[^\\s]+)`;
const LEADING_ENV_ASSIGNMENT = new RegExp(
	`^((?:[A-Za-z_][A-Za-z0-9_]*=${ENV_ASSIGNMENT_VALUE}\\s+)*)`,
);

function commandAfterEnvPrefix(input: string): string {
	const prefix = input.match(LEADING_ENV_ASSIGNMENT)?.[1] ?? "";
	return input.slice(prefix.length).trimStart();
}

function isAlreadyRtkCommand(command: string): boolean {
	const body = commandAfterEnvPrefix(command.trimStart());
	return body === "rtk" || body.startsWith("rtk ");
}

/**
 * Return the list of sudo sub-commands found in parsed chain segments.
 * Each entry is the full segment body (trimmed) that starts with `sudo`.
 * Operators are excluded. Returns empty array if none found.
 */
export function detectSudoSegments(parts: string[]): string[] {
	return parts
		.filter((p) => !(p.trim() in CHAIN_OPERATORS))
		.map((p) => p.trim())
		.filter((p) => /^sudo\b/.test(p));
}

/**
 * Build the block reason string shown to the model when a sudo command is
 * intercepted. Directs the model to `sudo_run` when available, otherwise
 * explains the restriction clearly.
 */
export function buildSudoBlockReason(
	sudoCmds: string[],
	hasSudoRunTool: boolean,
): string {
	const list = sudoCmds.map((c) => `  - ${c}`).join("\n");
	if (hasSudoRunTool) {
		return (
			`bash cannot run sudo commands directly. ` +
			`Use the \`sudo_run\` tool instead — it shows the user a confirmation dialog ` +
			`and handles authentication securely.\n` +
			`Blocked command(s):\n${list}\n` +
			`Strip the leading \`sudo\` from the command and pass the rest to \`sudo_run\` ` +
			`with a clear \`reason\` parameter.`
		);
	}
	return (
		`bash cannot run sudo commands in this session — ` +
		`no sudo_run tool is available and direct sudo is not permitted.\n` +
		`Blocked command(s):\n${list}\n` +
		`Ask the user to run the command manually with elevated privileges.`
	);
}

/**
 * Pure decision + mutation step for the `tool_call` hook.
 *
 * Given a tool-call event and whether RTK is available, mutate `event.input`
 * in place (the SDK's only supported way to patch tool args) when the command
 * is a rewritable bash command. Returns true if the command was rewritten.
 *
 * Extracted from the hook closure so the integration is directly testable
 * without a live ExtensionAPI.
 */

export async function applyRtkRewrite(
	event: BashCallEvent,
	opts: { enabled: boolean; rtkAvailable: boolean; rewrite?: RtkRewriteLookup },
): Promise<boolean> {
	if (!opts.enabled) return false;
	if (!opts.rtkAvailable) return false;
	if (event.toolName !== "bash") return false;

	const command = event.input?.command;
	if (typeof command !== "string" || !command) return false;

	const rewritten = await rewriteChain(command, opts.rewrite);
	if (rewritten === command) return false;

	event.input.command = rewritten;
	return true;
}

const RTK_SYSTEM_PROMPT = `# RTK — token-optimized command wrapper

Prefix shell commands with \`rtk\` when RTK wraps them (e.g. \`rtk git status\`). The auto-rewriter uses \`rtk rewrite\` as the allowlist and additionally wraps \`bun test\` as \`rtk test bun test\` (failures only). Leave \`npm publish\`, \`cargo publish\`, \`docker login\`, and other unsupported commands raw.

Prefix EVERY supported segment in a chain, not just the first:
\`rtk git add . && rtk git commit -m "msg" && rtk git push\`

RTK also has filtering subcommands the auto-rewriter only adds for \`bun test\`. Reach for these yourself otherwise: \`rtk err <cmd>\` (errors only), \`rtk summary <cmd>\`, \`rtk log <file>\` (dedup), \`rtk json <file>\` (structure), \`rtk test <cmd>\` (failures only), \`rtk gain\` (savings stats).`;

/**
 * Runners with no `rtk <cmd>` wrapper. Rewrite `bun test …` to
 * `rtk test bun test …` (RTK's generic failures-only filter).
 * Do not send other bun subcommands through `rtk test`.
 */
const RTK_TEST_SUBCOMMANDS: Record<string, Record<string, true>> = {
	bun: { test: true },
};

/** `rtk find` rejects compound predicates/actions; official rewrite still prefixes them. */
const FIND_UNSAFE_PREDICATE = /(?:^|\s)-(?:not|exec|ok|or|and|o|a)(?:\s|$)/;

function firstNonFlagToken(tokens: readonly string[]): string | undefined {
	for (const token of tokens) {
		if (token === "--") continue;
		if (token.startsWith("-")) continue;
		return token;
	}
	return undefined;
}

/** `rtk test <body>` when this segment is a known generic test runner. */
function genericRtkTestRewrite(body: string): string | undefined {
	const envPrefix = body.match(LEADING_ENV_ASSIGNMENT)?.[1] ?? "";
	const rest = body.slice(envPrefix.length);
	const tokens = rest.split(/\s+/).filter(Boolean);
	const command = tokens[0];
	if (!command || command === "rtk") return undefined;
	const testSubs = RTK_TEST_SUBCOMMANDS[command];
	if (!testSubs) return undefined;
	const subcommand = firstNonFlagToken(tokens.slice(1));
	if (subcommand === undefined || !(subcommand in testSubs)) return undefined;
	return `${envPrefix}rtk test ${rest}`;
}

function undoUnsafeFindPrefix(body: string): string {
	if (!/^rtk\s+find\b/.test(body)) return body;
	const raw = body.replace(/^rtk\s+/, "");
	return FIND_UNSAFE_PREDICATE.test(raw) ? raw : body;
}

interface RtkStatus {
	available: boolean;
	checkedAt: number;
}

/** Probe the command we actually use instead of relying on a platform-specific locator. */
export function probeRtkAvailability(
	pi: Pick<ExtensionAPI, "exec">,
): Promise<boolean> {
	return canExecute(pi, "rtk", ["--version"]);
}

/**
 * Split a command line into segments at top-level shell operators
 * (&&, ||, ;, |), keeping the operators as their own tokens. Operators
 * inside single/double quotes are ignored.
 *
 * Returns null if the parser hits something it can't safely reason about
 * (unbalanced quotes), so the caller can skip rewriting.
 */
export function splitChain(command: string): string[] | null {
	const out: string[] = [];
	let buf = "";
	let quote: "'" | '"' | null = null;

	for (let i = 0; i < command.length; i++) {
		const c = command[i] ?? "";
		const next = command[i + 1];

		if (quote) {
			buf += c;
			if (c === quote) quote = null;
			continue;
		}

		if (c === "'" || c === '"') {
			quote = c;
			buf += c;
			continue;
		}

		// two-char operators
		if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
			out.push(buf, c + c);
			buf = "";
			i++;
			continue;
		}

		// single-char operators
		if (c === ";" || c === "|") {
			out.push(buf, c);
			buf = "";
			continue;
		}

		buf += c;
	}

	if (quote) return null; // unbalanced quote — bail out
	out.push(buf);
	return out;
}

const CHAIN_OPERATORS: Record<string, true> = {
	"&&": true,
	"||": true,
	";": true,
	"|": true,
};

function mapCommandSegments(
	command: string,
	mapBody: (body: string) => string,
): string {
	const parts = splitChain(command);
	if (!parts) return command;
	let changed = false;
	const rewritten = parts.map((part) => {
		if (part.trim() in CHAIN_OPERATORS) return part;
		const leading = part.match(/^\s*/)?.[0] ?? "";
		const body = part.slice(leading.length);
		if (!body) return part;
		const next = mapBody(body);
		if (next === body) return part;
		changed = true;
		return `${leading}${next}`;
	});
	return changed ? rewritten.join("") : command;
}

/** Ask `rtk rewrite` via spawn. Used by tests without an ExtensionAPI. */
export function rtkRewriteLookup(command: string): string | undefined {
	try {
		const result = Bun.spawnSync(["rtk", "rewrite", "--", command], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode === null) return undefined;
		const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : "";
		return parseRtkRewriteOutput(result.exitCode, stdout, command);
	} catch {
		return undefined;
	}
}

/** Ask `rtk rewrite` through Pi's executor with a timeout. */
export function createRtkExecLookup(
	pi: Pick<ExtensionAPI, "exec">,
): RtkRewriteLookup {
	return async (command) => {
		try {
			const result = await pi.exec("rtk", ["rewrite", "--", command], {
				timeout: RTK_REWRITE_TIMEOUT_MS,
			});
			return parseRtkRewriteOutput(result.code, result.stdout ?? "", command);
		} catch {
			return undefined;
		}
	};
}

/**
 * Rewrite a bash command using official `rtk rewrite`, then apply fork overlays:
 * `bun test` → `rtk test bun test`, and unwrap `rtk find` with -not/-exec.
 * Pass `lookup` in tests. Returns the original string if nothing changed.
 */
export async function rewriteChain(
	command: string,
	lookup: RtkRewriteLookup = rtkRewriteLookup,
): Promise<string> {
	if (!splitChain(command)) return command;
	const official = isAlreadyRtkCommand(command)
		? command
		: ((await lookup(command)) ?? command);
	const afterFind = mapCommandSegments(official, undoUnsafeFindPrefix);
	return mapCommandSegments(
		afterFind,
		(body) => genericRtkTestRewrite(body) ?? body,
	);
}

export function rtk(
	pi: ExtensionAPI,
	status: OptimizerStatus,
): OptimizerHandle {
	let rtkStatus: RtkStatus | null = null;
	let warnedMissing = false;
	let enabled = true;
	// Tracks whether pix-sudo's sudo_run tool is active this session.
	// Set from before_agent_start selectedTools; defaults to false until known.
	let hasSudoRunTool = false;

	// Report into the shared optimizer indicator. RTK counts as "on" only when
	// enabled AND the binary is actually available.
	function syncStatus(ctx: Pick<ExtensionContext, "ui">) {
		status.set("rtk", enabled && rtkStatus?.available === true, ctx);
	}

	// Check if rtk binary is available
	const checkRtkAvailability = async (): Promise<RtkStatus> => {
		// Cache for 60 seconds
		if (rtkStatus && Date.now() - rtkStatus.checkedAt < 60000) {
			return rtkStatus;
		}

		const available = await probeRtkAvailability(pi);
		rtkStatus = {
			available,
			checkedAt: Date.now(),
		};
		if (available) warnedMissing = false;
		return rtkStatus;
	};

	// Inject RTK system prompt + detect sudo_run tool availability.
	pi.on("before_agent_start", async (event) => {
		// The active tool list is exposed by OMP's public ExtensionAPI.
		hasSudoRunTool = pi.getActiveTools().includes("sudo_run");

		if (!enabled) return undefined;
		return { systemPrompt: [RTK_SYSTEM_PROMPT, ...event.systemPrompt] };
	});

	// Keep the status indicator in sync across the agent lifecycle. Probe
	// availability on session start so the icon reflects reality immediately.
	pi.on("session_start", async (_event, ctx) => {
		// Restore the user's on/off choice from disk (survives quit/restart).
		const saved = await loadOptValue("rtk");
		if (saved === "on" || saved === "off") enabled = saved === "on";
		const probe = await checkRtkAvailability();
		if (!probe.available && !warnedMissing) {
			ctx.ui.notify(
				"rtk not found — RTK rewriting disabled. Install: cargo install rtk-ai",
				"warning",
			);
			warnedMissing = true;
		}
		syncStatus(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		syncStatus(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		syncStatus(ctx);
	});

	// -- Overlay value handler (called by the /optimizer overlay) --

	async function run(
		value: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		enabled = value === "on";
		await saveOptValue("rtk", enabled ? "on" : "off");

		await checkRtkAvailability();
		syncStatus(ctx);
		ctx.ui.notify(`RTK rewriting ${enabled ? "on" : "off"}.`, "info");
	}

	// Rewrite bash commands to add rtk prefix.
	//
	// The SDK fires a single `tool_call` event for every tool. The bash variant
	// carries `event.toolName === "bash"` and a mutable `event.input` of shape
	// `{ command: string; timeout?: number }`. Arguments are patched by mutating
	// `event.input` IN PLACE — returning `{ toolInput: ... }` does nothing.
	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) {
			return undefined;
		}

		if (event.toolName !== "bash") {
			return undefined;
		}

		const probe = await checkRtkAvailability();

		if (!probe.available) {
			return undefined; // Don't rewrite if rtk not available
		}

		// First confirmed-available probe may have flipped state — refresh icon.
		syncStatus(ctx);

		// Block sudo segments before rtk rewriting.
		// splitChain is safe to call here — same parser used by rewriteChain.
		const command = event.input?.command;
		if (typeof command === "string" && command) {
			const parts = splitChain(command);
			if (parts) {
				const sudoCmds = detectSudoSegments(parts);
				if (sudoCmds.length > 0) {
					const reason = buildSudoBlockReason(sudoCmds, hasSudoRunTool);
					return { block: true, reason };
				}
			}
		}

		// Rewrite via `rtk rewrite` plus bun-test overlay.
		// Mutates `event.input.command` in place — the SDK's supported patch path.
		await applyRtkRewrite(event, {
			enabled,
			rtkAvailable: probe.available,
			rewrite: createRtkExecLookup(pi),
		});
		return undefined;
	});

	return {
		name: "rtk",
		help: "rtk — prefix shell commands with rtk (token-optimized)",
		values: ["off", "on"],
		current: () => (enabled ? "on" : "off"),
		run,
	};
}
