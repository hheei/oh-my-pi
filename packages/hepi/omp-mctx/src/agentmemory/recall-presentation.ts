import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { PREVIEW_LIMITS, shortenPath, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import type { Database } from "../core/shared/sqlite";
import { claimRecallPresentation, completeRecallPresentation, type RecallEvent } from "./recall-ledger";

const RECALL_PREVIEW_WIDTH = PREVIEW_LIMITS.OUTPUT_EXPANDED * TRUNCATE_LENGTHS.LONG;
const RECALL_PREVIEW_LINES = PREVIEW_LIMITS.EXPANDED_LINES;

type RecallPresentationUI = {
	setWidget(key: string, lines: string[], options?: { placement?: "aboveEditor" }): void;
};

export type RecallPresentationResult =
	| { presented: true }
	| { presented: false; reason: "headless" | "already-presented" | "ui-error" };

/** Renders an admitted recall snapshot without changing its persisted provider bytes. */
export function formatRecallPresentationLines(event: RecallEvent, width = RECALL_PREVIEW_WIDTH): string[] {
	const body = new TextDecoder().decode(event.body);
	return body
		.split("\n")
		.slice(0, RECALL_PREVIEW_LINES)
		.map(line => truncateToWidth(replaceTabs(shortenPath(line)), width));
}

/** Presents an admitted recall once on the interactive TUI surface. */
export function presentAdmittedRecall(input: {
	db: Database;
	ui?: RecallPresentationUI;
	hasUI: boolean;
	event: RecallEvent;
	presenterToken: string;
}): RecallPresentationResult {
	if (!input.hasUI || !input.ui?.setWidget) return { presented: false, reason: "headless" };
	try {
		if (!claimRecallPresentation(input.db, input.event.eventId, input.presenterToken)) {
			return { presented: false, reason: "already-presented" };
		}
		input.ui.setWidget("agentmemory-recall", formatRecallPresentationLines(input.event), {
			placement: "aboveEditor",
		});
		completeRecallPresentation(input.db, input.event.eventId, input.presenterToken);
		return { presented: true };
	} catch {
		return { presented: false, reason: "ui-error" };
	}
}
