// Pi-native ctx_reduce nudge delivery. Both channels send visible custom
// session messages: the model sees raw <system-reminder> content, while the
// registered renderer presents a distinct [magic context] transcript block.

import {
	casChannel2NudgeState,
	getChannel2NudgeState,
	getLastNudgeLevel,
	getLastNudgeUndropped,
	resetLastNudgeCycle,
	setChannel2NudgeState,
	setLastNudgeLevel,
	setLastNudgeUndropped,
} from "#core/features/storage";
import {
	buildChannel1Reminder,
	buildChannel2Reminder,
	CHANNEL1_MIN_TURNS_BETWEEN_NUDGES,
	type Channel1Level,
	type Channel1State,
	computePressure,
	decideChannel1,
	isDroppedToolOutput,
	shouldTriggerChannel2,
	type TailTokenEstimate,
	tailToolTokensFromStrings,
	toolOutputTokens,
} from "#core/hooks/ctx-reduce-nudge";
import { sessionLog } from "#core/shared/logger";
import type { Database } from "#core/shared/sqlite";

export const CHANNEL1_NUDGE_CUSTOM_TYPE = "magic-context:ctx-reduce-nudge";
export const CHANNEL2_NUDGE_CUSTOM_TYPE = "magic-context:ceiling-nudge";

export interface Channel1NudgeMessageDetails {
	displayText: string;
}

export interface Channel1Reminder {
	content: string;
	displayText: string;
	display: boolean;
	nextLastNudge: number;
	nextLastNudgeLevel: Channel1Level | "";
}

function sealDeliveredAfterUnconfirmedSend(
	db: Database,
	sessionId: string,
): "already-delivered" | "sealed" | "stuck-claimed" {
	try {
		if (getChannel2NudgeState(db, sessionId) === "delivered") {
			return "already-delivered";
		}
	} catch {
		// Best-effort probe only — if the read fails, still try to seal the cap.
	}

	try {
		setChannel2NudgeState(db, sessionId, "delivered");
		return "sealed";
	} catch {
		// Preserve the stale claim so the shared TTL heal can recover it later.
		return "stuck-claimed";
	}
}

// Per-session Channel 1 metric baseline. Written at the end of each pipeline
// pass (post-drop), read in the `tool_result` handler. Primary-only: subagents

const channel1StateBySession = new Map<string, Channel1State>();
const channel1TurnsSinceNudge = new Map<string, number>();

export function advancePiChannel1Turn(sessionId: string): void {
	const turns = channel1TurnsSinceNudge.get(sessionId);
	if (turns === undefined) return;
	channel1TurnsSinceNudge.set(sessionId, Math.min(CHANNEL1_MIN_TURNS_BETWEEN_NUDGES, turns + 1));
}

function canDeliverPiChannel1Reminder(sessionId: string): boolean {
	const turns = channel1TurnsSinceNudge.get(sessionId);
	return turns === undefined || turns >= CHANNEL1_MIN_TURNS_BETWEEN_NUDGES;
}

export function setPiChannel1Baseline(sessionId: string, state: Channel1State): void {
	channel1StateBySession.set(sessionId, state);
}

export function getPiChannel1Baseline(sessionId: string): Channel1State | undefined {
	return channel1StateBySession.get(sessionId);
}

export function clearPiChannel1State(sessionId: string): void {
	channel1StateBySession.delete(sessionId);
	channel1TurnsSinceNudge.delete(sessionId);
}

/** Mark that the agent ran ctx_reduce since the last baseline refresh (suppress self-nag). */
export function markPiChannel1Reduced(sessionId: string, db?: Database): void {
	const state = channel1StateBySession.get(sessionId);
	if (state) state.reducedSinceRefresh = true;
	if (db) resetLastNudgeCycle(db, sessionId);
}

interface PiTextContent {
	type: "text";
	text: string;
}

function isPiTextContent(c: unknown): c is PiTextContent {
	return (
		c !== null &&
		typeof c === "object" &&
		(c as { type?: unknown }).type === "text" &&
		typeof (c as { text?: unknown }).text === "string"
	);
}

/** Concatenated text of a `toolResult.content[]` (image blocks ignored). */
function toolResultText(content: readonly unknown[]): string {
	let text = "";
	for (const c of content) {
		if (isPiTextContent(c)) text += c.text;
	}
	return text;
}

/**
 * Sum approximate tokens of non-dropped tool output across Pi messages. Pi tool
 * output lives in `toolResult.content[].text`; the math is shared.
 * `messages` is the post-injection wire array, already trimmed to the live tail.
 */
export function computeTailToolTokensPi(messages: readonly unknown[]): number {
	const outputs: string[] = [];
	for (const m of messages) {
		if (m !== null && typeof m === "object" && (m as { role?: unknown }).role === "toolResult") {
			const content = (m as { content?: unknown }).content;
			if (Array.isArray(content)) outputs.push(toolResultText(content));
		}
	}
	return tailToolTokensFromStrings(outputs);
}

function jsonTokens(value: unknown): number {
	if (value === undefined || value === null) return 0;
	try {
		return toolOutputTokens(JSON.stringify(value));
	} catch {
		return 0;
	}
}

function textTokens(content: unknown): number {
	if (typeof content === "string") return toolOutputTokens(content);
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as { type?: unknown; text?: unknown; thinking?: unknown };
		if (typeof p.text === "string") tokens += toolOutputTokens(p.text);
		else if (typeof p.thinking === "string") tokens += toolOutputTokens(p.thinking);
		else if (p.type === "image") tokens += 1200;
	}
	return tokens;
}

export function computeTailTokenEstimatePi(messages: readonly unknown[]): TailTokenEstimate {
	let tailToolTokens = 0;
	let liveTailTokens = 0;
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as { role?: unknown; content?: unknown };
		if (msg.role === "toolResult") {
			const outputText = Array.isArray(msg.content)
				? toolResultText(msg.content)
				: typeof msg.content === "string"
					? msg.content
					: "";
			const outputTokens =
				outputText && !isDroppedToolOutput(outputText) ? toolOutputTokens(outputText) : 0;
			tailToolTokens += outputTokens;
			liveTailTokens += outputTokens;
			continue;
		}
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (!part || typeof part !== "object") continue;
				const p = part as {
					type?: unknown | undefined;
					name?: unknown | undefined;
					arguments?: unknown | undefined;
				};
				if (p.type === "toolCall") {
					if (typeof p.name === "string") liveTailTokens += toolOutputTokens(p.name);
					liveTailTokens += jsonTokens(p.arguments);
				}
			}
		}
		liveTailTokens += textTokens(msg.content);
	}
	return { tailToolTokens, liveTailTokens };
}

/**
 * Channel 1 decision for a just-finished tool result. The caller persists it as
 * a distinct Pi custom message, leaving tool output untouched. `toolName` of
 * `ctx_reduce` suppresses the reminder because the agent is managing context.
 */
export function maybeChannel1ReminderForToolResult(args: {
	db: Database;
	sessionId: string;
	toolName: string;
	content: readonly unknown[];
}): Channel1Reminder | null {
	const { db, sessionId, toolName } = args;
	const state = channel1StateBySession.get(sessionId);
	if (!state) return null; // primary-only: no baseline ⇒ subagent ⇒ off
	if (!canDeliverPiChannel1Reminder(sessionId)) return null;

	if (toolName === "ctx_reduce") {
		state.reducedSinceRefresh = true;
		resetLastNudgeCycle(db, sessionId);
		return null;
	}

	const text = toolResultText(args.content);
	if (text.length === 0) return null;

	// Accumulate this tool's tokens into the per-turn accumulator (prospective:
	// not yet reflected in the baseline tail snapshot).
	state.turnToolTokens += toolOutputTokens(text);

	if (state.reducedSinceRefresh) return null;

	const undroppedTokens = state.tailToolTokens + state.turnToolTokens;
	const pressure = computePressure({
		lastInputTokens: state.lastInputTokens,
		turnToolTokens: state.turnToolTokens,
		contextLimit: state.contextLimit,
		executeThresholdPercentage: state.executeThresholdPercentage,
	});

	const workingWindowTokens = Math.round(
		(state.contextLimit * state.executeThresholdPercentage) / 100,
	);
	const decision = decideChannel1({
		undroppedTokens,
		pressure,
		estimatedInputTokens: state.lastInputTokens + state.turnToolTokens,
		workingWindowTokens,
		lastNudgeUndropped: getLastNudgeUndropped(db, sessionId),
		lastNudgeLevel: getLastNudgeLevel(db, sessionId),
		hasRecentReduce: false, // handled by reducedSinceRefresh above
	});

	if (!decision.fire) return null;

	const content = buildChannel1Reminder(
		decision.level,
		decision.undroppedTokens,
		state.oldestReclaimableToolTags,
	);
	return {
		content,
		displayText: content
			.replace(/^\n*<system-reminder>\n?/, "")
			.replace(/\n?<\/system-reminder>\s*$/, ""),
		display: decision.level === "urgent",
		nextLastNudge: decision.nextLastNudge,
		nextLastNudgeLevel: decision.nextLastNudgeLevel,
	};
}

export function markChannel1ReminderDelivered(
	db: Database,
	sessionId: string,
	reminder: Pick<Channel1Reminder, "nextLastNudge" | "nextLastNudgeLevel">,
): void {
	channel1TurnsSinceNudge.set(sessionId, 0);
	setLastNudgeUndropped(db, sessionId, reminder.nextLastNudge);
	setLastNudgeLevel(db, sessionId, reminder.nextLastNudgeLevel);
}

/**
 * Minimal shape of the Pi API needed to deliver a Channel 2 ceiling nudge.
 * Uses `sendMessage` (custom message) rather than `sendUserMessage` so the nudge
 * can render `display: false` — hidden from the Pi TUI while still reaching the
 * model (Pi converts a `role:"custom"` entry to a model-visible user message via
 * `convertToLlm`).
 * model but NOT show up as a literal user turn the user didn't type. Available
 * since published pi-coding-agent 0.74.0 (our floor); MC already uses
 * `sendMessage` for /ctx-status.
 */
interface PiSendMessage {
	sendMessage: (
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown | undefined;
		},
		options?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean },
	) => void;
}

/**
 * Deliver a pending Channel 2 ceiling nudge for `sessionId`, if any. Safe to
 * call from BOTH delivery sites; no-ops unless a `pending` intent exists. Pi
 * is single-process so delivery coalesces natively — no #28202 workaround.
 * Delivered as a visible custom message: renderer presents `[magic context]`
 * while Pi sends raw `<system-reminder>` content to the model.
 *
 * Delivery sites + mode:
 * - `tool_result` (mid-turn, the primary site): deliverAs "steer" — Pi queues
 *   the message and the agent loop pulls it at the NEXT STEP boundary, so the
 *   agent is warned while the pile is still growing and can act THIS turn.
 *   Waiting for idle would deliver the warning after all the growth happened.
 * - `agent_end` (idle fallback): catches the intent when the turn ended before
 *   a tool boundary could deliver it; deliverAs "followUp" starts a fresh turn.
 *
 * Lease: pending → claimed → delivered (revert to pending on failure so a
 * transient error doesn't burn the one-shot cap). Returns true on delivery.
 */
export function maybeDeliverChannel2Pi(
	pi: PiSendMessage,
	db: Database,
	sessionId: string,
	deliverAs: "steer" | "followUp" = "followUp",
): boolean {
	let state: string;
	try {
		state = getChannel2NudgeState(db, sessionId);
	} catch {
		return false;
	}
	if (state !== "pending") return false;

	// Revalidate before delivery.
	// The `pending` intent was recorded at high pressure during a context pass;
	// by this agent_end the agent may have run ctx_reduce (markPiChannel1Reduced
	// + the next pass refreshes the baseline), so the ceiling condition may no
	// longer hold. Firing anyway injects a stale follow-up AND burns the
	// one-per-session cap.
	//
	// Two rules, both cap-preserving:
	// - UNKNOWN baseline → do NOT deliver, do NOT touch the lease: leave
	//   `pending` for a later agent_end with a real measurement. Never
	//   substitute a default and burn the cap on an unvalidated condition.
	// - KNOWN baseline → re-run the FULL trigger predicate (floor AND the
	//   reclaimable ≥ usable/3 ratio that armed the intent), not just the
	//   floor. Predicate false → cancel to '' (re-armable).
	const baseline = channel1StateBySession.get(sessionId);
	if (!baseline) return false;
	if (baseline.reducedSinceRefresh) return false;
	const undropped = baseline.tailToolTokens + baseline.turnToolTokens;
	if (
		!shouldTriggerChannel2({
			reclaimableTokens: undropped,
			usableTokens: baseline.usableTokens,
		})
	) {
		try {
			casChannel2NudgeState(db, sessionId, "pending", "");
		} catch {
			// best-effort; next pass re-evaluates.
		}
		return false;
	}

	if (!casChannel2NudgeState(db, sessionId, "pending", "claimed")) return false;

	try {
		const content = buildChannel2Reminder(undropped, baseline.oldestReclaimableToolTags);
		pi.sendMessage(
			{
				customType: CHANNEL2_NUDGE_CUSTOM_TYPE,
				content,
				display: true,
				details: {
					kind: "channel-2-ceiling-nudge",
					displayText: content
						.replace(/^\n*<system-reminder>\n?/, "")
						.replace(/\n?<\/system-reminder>\s*$/, ""),
				},
			},
			{ deliverAs },
		);
	} catch (error) {
		try {
			casChannel2NudgeState(db, sessionId, "claimed", "pending");
		} catch (revertError) {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge delivery failed; pending restore was busy so the stale claim will heal later:",
				{ deliveryError: error, revertError },
			);
			return false;
		}
		sessionLog(sessionId, "channel2 ceiling nudge delivery failed (will retry):", error);
		return false;
	}

	try {
		const confirmed = casChannel2NudgeState(db, sessionId, "claimed", "delivered");
		if (confirmed) {
			sessionLog(sessionId, "channel2 ceiling nudge delivered");
			return true;
		}

		const outcome = sealDeliveredAfterUnconfirmedSend(db, sessionId);
		if (outcome === "already-delivered") {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge duplicate window: our send returned after a sibling reclaimed the stale lease and already delivered",
			);
		} else if (outcome === "sealed") {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge sent but claim confirmation was lost; sealed delivered without an authoritative confirm",
			);
		} else {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge sent but claim confirmation was lost; lease stayed claimed and will heal later",
			);
		}
		return false;
	} catch (error) {
		// The nudge has already been handed to Pi; never re-arm on a post-send
		// confirm failure, or a transient DB error can duplicate the one-shot cap.
		const outcome = sealDeliveredAfterUnconfirmedSend(db, sessionId);
		if (outcome === "already-delivered") {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge duplicate window: our send returned after a sibling reclaimed the stale lease and already delivered",
			);
		} else if (outcome === "sealed") {
			sessionLog(sessionId, "channel2 ceiling nudge sent but confirm failed:", error);
		} else {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge sent but confirm failed; lease stayed claimed and will heal later:",
				error,
			);
		}
		return false;
	}
}
