import OpenCC from "opencc-js/t2cn";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadOptValue, saveOptValue } from "./persist.ts";
import type { OptimizerHandle, OptimizerStatus } from "./status.ts";

interface Fence {
	readonly char: "`" | "~";
	readonly length: number;
}

export type T2sLevel = "on" | "off";
export const T2S_LEVELS: readonly T2sLevel[] = ["on", "off"];
const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });

function matchFence(line: string): Fence | undefined {
	let start = 0;
	while (start < line.length && (line[start] === " " || line[start] === "\t")) start++;
	const char = line[start];
	if (char !== "`" && char !== "~") return undefined;
	let end = start;
	while (end < line.length && line[end] === char) end++;
	return end - start >= 3 ? { char, length: end - start } : undefined;
}

function proseLine(line: string): string {
	let output = "";
	let cursor = 0;
	while (cursor < line.length) {
		const openStart = line.indexOf("`", cursor);
		if (openStart < 0) return output + toSimplified(line.slice(cursor)).replaceAll("甚么", "什么");
		output += toSimplified(line.slice(cursor, openStart)).replaceAll("甚么", "什么");
		let openEnd = openStart;
		while (openEnd < line.length && line[openEnd] === "`") openEnd++;
		const delimiterLength = openEnd - openStart;
		let searchFrom = openEnd;
		let closeEnd = -1;
		while (searchFrom < line.length) {
			const candidateStart = line.indexOf("`", searchFrom);
			if (candidateStart < 0) break;
			let candidateEnd = candidateStart;
			while (candidateEnd < line.length && line[candidateEnd] === "`") candidateEnd++;
			if (candidateEnd - candidateStart === delimiterLength) {
				closeEnd = candidateEnd;
				break;
			}
			searchFrom = candidateEnd;
		}
		if (closeEnd < 0) return output + line.slice(openStart);
		output += line.slice(openStart, closeEnd);
		cursor = closeEnd;
	}
	return output;
}

export function convertInputText(text: string): string {
	const lines = text.split("\n");
	let activeFence: Fence | undefined;
	let output = "";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line === undefined) continue;
		const hasLineFeed = index < lines.length - 1;
		const fence = matchFence(line);
		if (activeFence) {
			output += line + (hasLineFeed ? "\n" : "");
			if (fence?.char === activeFence.char && fence.length >= activeFence.length) activeFence = undefined;
		} else if (fence) {
			activeFence = fence;
			output += line + (hasLineFeed ? "\n" : "");
		} else {
			output += proseLine(line) + (hasLineFeed ? "\n" : "");
		}
	}
	return output;
}


export function t2s(pi: ExtensionAPI, status: OptimizerStatus): OptimizerHandle {
	let level: T2sLevel = "on";

	function syncStatus(ctx: Pick<ExtensionContext, "ui">) {
		status.set("t2s", level === "on", ctx);
	}

	pi.on("input", (event, _ctx) => {
		if (level !== "on" || event.source !== "interactive") return undefined;
		const text = convertInputText(event.text);
		return text === event.text ? undefined : { action: "transform", text };
	});

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "t2s-level") continue;
			const saved = entry.data && typeof entry.data === "object" && "level" in entry.data ? entry.data.level : undefined;
			if (saved === "on" || saved === "off") level = saved;
		}
		const saved = loadOptValue("t2s");
		if (saved === "on" || saved === "off") level = saved;
		syncStatus(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => syncStatus(ctx));
	pi.on("agent_end", async (_event, ctx) => syncStatus(ctx));

	async function run(value: string, ctx: ExtensionCommandContext): Promise<void> {
		if (value !== "on" && value !== "off") return;
		level = value;
		pi.appendEntry("t2s-level", { level });
		saveOptValue("t2s", level);
		syncStatus(ctx);
		ctx.ui.notify(`T2S ${level === "on" ? "enabled" : "disabled"}`, "info");
	}


	return {
		name: "t2s",
		help: "t2s — convert Traditional Chinese input to Simplified Chinese",
		values: T2S_LEVELS,
		current: () => level,
		run,
	};
}
