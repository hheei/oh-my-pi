import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { OptimizerHandle, OptimizerStatus } from "./status.ts";
import { loadOptValue, saveOptValue } from "./persist.ts";

export type EditGuardLevel = "on" | "off";
export const EDIT_GUARD_LEVELS: readonly EditGuardLevel[] = ["on", "off"];

const EDIT_GUARD_TOOL = "edit-guard" as const;
const APPLY_PATCH_COMMAND = /(?:^|[\n;&|()])\s*(?:command\s+)?apply_patch\s/;
const HASHLINE_FILE_HEADER = /^\[[^\]\r\n#]+#[0-9a-f]{4}\]/im;
const HASHLINE_HUNK_HEADER = /^@@/m;
const HASHLINE_GUARD_MESSAGE =
	"Hashline edit was aborted: `@@` is unified-diff syntax, not hashline syntax. Re-read the file, then retry with `[path#HASH]` plus `PUT`, `CUT`, `REM`, or `MV`. Do not retry the same payload.";
const NO_EDIT_TOOL_GUIDANCE =
	"`apply_patch` is unavailable; the call was aborted. No supported file-editing tool is active. Enable `edit`, or `write` before retrying.";
const APPLY_PATCH_RETRY_WARNING = "Do not retry `apply_patch`.";

declare global {
	var __ompOptimizerEditGuardRegistrations: WeakMap<object, symbol> | undefined;
}

function currentRegistration(pi: ExtensionAPI): () => boolean {
	const identity: object = typeof pi.events === "object" && pi.events !== null ? pi.events : pi;
	let registrations = globalThis.__ompOptimizerEditGuardRegistrations;
	if (registrations === undefined) {
		registrations = new WeakMap();
		globalThis.__ompOptimizerEditGuardRegistrations = registrations;
	}
	const token = Symbol("omp-optimizer-edit-guard");
	registrations.set(identity, token);
	return () => registrations.get(identity) === token;
}

/** Detects a streamed shell attempt to invoke apply_patch, excluding plain mentions. */
export function hasStreamingApplyPatchCommand(command: string): boolean {
	return APPLY_PATCH_COMMAND.test(command);
}

/** Detects top-level unified-diff hunk syntax inside a hashline edit payload. */
export function hasMalformedHashlineInput(input: string): boolean {
	return HASHLINE_FILE_HEADER.test(input) && HASHLINE_HUNK_HEADER.test(input);
}

function blockReason(activeTools: readonly string[]): string {
	const alternatives = ["edit", "write"].filter(name => activeTools.includes(name));
	if (alternatives.length === 0) return NO_EDIT_TOOL_GUIDANCE;
	const names = alternatives.map(name => `\`${name}\``);
	const action = names.length === 1 ? names[0] : `${names[0]} or ${names[1]}`;
	return `\`apply_patch\` is unavailable; the call was aborted. Continue with ${action}. ${APPLY_PATCH_RETRY_WARNING}`;
}

/** Aborts malformed hashline edits and unavailable shell apply_patch calls. */
export function editGuard(pi: ExtensionAPI, status: OptimizerStatus): OptimizerHandle {
	let level: EditGuardLevel = "on";
	const isCurrent = currentRegistration(pi);
	let interrupted = false;
	let pendingReason: string | undefined;

	function syncStatus(ctx: Pick<ExtensionContext, "ui">): void {
		status.set(EDIT_GUARD_TOOL, level === "on", ctx);
	}

	pi.on("before_agent_start", () => {
		if (!isCurrent()) return;
		interrupted = false;
	});
	pi.on("session_start", (_event, ctx) => {
		if (!isCurrent()) return;
		interrupted = false;
		pendingReason = undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "edit-guard-level") continue;
			const saved = entry.data && typeof entry.data === "object" && "level" in entry.data ? entry.data.level : undefined;
			if (saved === "on" || saved === "off") level = saved;
		}
		const saved = loadOptValue(EDIT_GUARD_TOOL);
		if (saved === "on" || saved === "off") level = saved;
		syncStatus(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => syncStatus(ctx));
	pi.on("agent_end", async (event, ctx) => {
		if (!isCurrent()) return;
		syncStatus(ctx);
		if (event.willContinue || pendingReason === undefined) return;
		const reason = pendingReason;
		pendingReason = undefined;
		pi.sendMessage(
			{
				customType: "edit-guard",
				content: reason,
				display: true,
			},
			{ triggerTurn: true },
		);
	});
	pi.on("session_shutdown", () => {
		if (!isCurrent()) return;
		pendingReason = undefined;
	});
	pi.on("message_update", (event, context) => {
		if (level !== "on" || interrupted || !isCurrent() || event.assistantMessageEvent.type !== "toolcall_delta") return;
		const update = event.assistantMessageEvent;
		const content = update.partial.content[update.contentIndex];
		if (content?.type !== "toolCall") return;

		let reason: string | undefined;
		if (content.name === "edit") {
			const input = content.arguments.input;
			if (typeof input === "string" && hasMalformedHashlineInput(input)) reason = HASHLINE_GUARD_MESSAGE;
		} else if (content.name === "bash") {
			if (pi.getActiveTools().includes("apply_patch")) return;
			const command = content.arguments.command;
			if (typeof command === "string" && hasStreamingApplyPatchCommand(command)) reason = blockReason(pi.getActiveTools());
		}
		if (reason === undefined) return;
		interrupted = true;
		pendingReason = reason;
		context.abort();
	});

	async function run(value: string, ctx: ExtensionCommandContext): Promise<void> {
		if (value !== "on" && value !== "off") return;
		level = value;
		pi.appendEntry("edit-guard-level", { level });
		saveOptValue(EDIT_GUARD_TOOL, level);
		syncStatus(ctx);
		ctx.ui.notify(`Edit Guard ${level === "on" ? "enabled" : "disabled"}`, "info");
	}

	return {
		name: EDIT_GUARD_TOOL,
		help: "Edit Guard — block malformed apply_patch syntax in hashline mode and unavailable shell apply_patch calls",
		values: EDIT_GUARD_LEVELS,
		current: () => level,
		run,
	};
}
