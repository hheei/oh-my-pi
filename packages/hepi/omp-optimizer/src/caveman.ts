/**
 * caveman.ts — pure logic + Pi extension
 *
 * Pure helpers exported for tests; caveman(pi) is the extension entry,
 * called by index.ts alongside rtk(pi).
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	createMode,
	resolveLevel as resolveLevelGeneric,
	toggleLevel as toggleLevelGeneric,
} from "./mode.ts";
import type { OptimizerHandle, OptimizerStatus } from "./status.ts";

// ── Levels ────────────────────────────────────────────────────────────────────

export const LEVELS = ["off", "lite", "full", "ultra", "micro"] as const;

export type Level = (typeof LEVELS)[number];

export const STOP_ALIASES = new Set(["off", "stop", "quit", "0"]);

// Numeric shortcuts: /caveman 1|2|3
export const LEVEL_NUMBERS: Record<string, Level> = {
	"1": "lite",
	"2": "full",
	"3": "ultra",
};

// ── Status labels ─────────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<Exclude<Level, "off">, string> = {
	lite: "LITE",
	full: "FULL",
	ultra: "ULTRA",
	micro: "MICRO",
};

// ── Prompt fragments ──────────────────────────────────────────────────────────

const BASE = `\
IMPORTANT: You are in CAVEMAN MODE. Respond terse like smart caveman. \
All technical substance stay. Only fluff die.

Rules:
- Drop articles (a/an/the), filler (just/really/basically/actually/simply), \
pleasantries, hedging
- Fragments OK. Short synonyms preferred. Technical terms exact
- Code blocks unchanged. Errors quoted exact
- Pattern: [thing] [action] [reason]. [next step].

Bad: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Good: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"`;

const MICRO_PROMPT = `# Token efficiency
Respond like smart caveman. Cut all filler, keep technical substance.
- Drop articles (a, an, the), filler (just, really, basically, actually).
- Drop pleasantries (sure, certainly, happy to).
- No hedging. Fragments fine. Short synonyms.
- Technical terms stay exact. Code blocks unchanged.
- Pattern: [thing] [action] [reason]. [next step].`;

const INTENSITY: Record<Exclude<Level, "off" | "micro">, string> = {
	lite: `\
No filler/hedging. Keep articles + full sentences. Professional but tight.
Example: "Your component re-renders because you create a new object reference each render. Wrap it in \`useMemo\`."`,

	full: `\
Drop articles, fragments OK, short synonyms.
Example: "New object ref each render. Inline object prop = new ref = re-render. Wrap in \`useMemo\`."`,

	ultra: `\
Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y).
Example: "Inline obj prop → new ref → re-render. \`useMemo\`."`,
};

const SAFETY = `\
Auto-clarity: drop caveman for security warnings, irreversible action confirmations, \
or when user is confused. Resume after.
Boundaries: write normal code. Only compress explanations. "stop caveman" or "normal mode" reverts.`;

/**
 * Build the system prompt injection for a given level.
 * Returns empty string when level is "off".
 */
export function buildPrompt(level: Level): string {
	if (level === "off") return "";
	if (level === "micro") return MICRO_PROMPT;
	return [BASE, "", `Intensity: ${INTENSITY[level]}`, "", SAFETY].join("\n");
}

// ── Level resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a raw command arg to a Level, or return null if unrecognised.
 * Handles stop aliases (stop/quit → "off") and valid level names.
 */
export function resolveLevel(arg: string): Level | null {
	return resolveLevelGeneric(arg, LEVELS, LEVEL_NUMBERS, STOP_ALIASES);
}

/**
 * Help text shown when /caveman is run with no argument.
 */
export function buildHelp(current: Level): string {
	const statusLine = current === "off" ? "off" : `${STATUS_LABELS[current]} (${current})`;
	return [
		`Caveman mode: ${statusLine}`,
		"",
		"Usage: /caveman <level>",
		"  1  lite   - professional, no fluff",
		"  2  full   - classic caveman",
		"  3  ultra  - maximum compression",
		"  0  off    - disable (aliases: off, stop, quit)",
		"",
		"Other levels: micro",
		"  config    - open settings dialog",
	].join("\n");
}

/**
 * Toggle: off → full, anything else → off.
 */
export function toggleLevel(current: Level): Level {
	return toggleLevelGeneric(current);
}

// ── Pi extension ────────────────────────────────────────────────────────────

export function caveman(pi: ExtensionAPI, status: OptimizerStatus): OptimizerHandle {
	return createMode(pi, status, {
		name: "caveman",
		help: "caveman — terse output",
		levels: LEVELS,
		buildPrompt,
		resolve: resolveLevel,
		notify: (level) => (level === "off" ? "Caveman mode off." : `Caveman: ${STATUS_LABELS[level]}`),
	});
}
