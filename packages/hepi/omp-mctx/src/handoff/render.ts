import type {
	CustomEntry,
	EntryRenderOptions,
	MessageRenderer,
	Theme,
} from "@oh-my-pi/pi-coding-agent";
import { Box, type Component, Container, Text } from "@oh-my-pi/pi-tui";
import {
	firstSummaryLine,
	HANDOFF_STAGE_LABELS,
	type HandoffAttemptRecord,
	type HandoffContextDetails,
	type HandoffProgressStage,
	type HandoffRequestRecord,
	type HandoffSourceContextSnapshot,
} from "./model";

export interface HandoffProgressState {
	stage: HandoffProgressStage;
	model?: string | undefined;
	tokenSummary?: string | undefined;
	startedAt: number;
	cancellable: boolean;
	now: number;
}

export function renderHandoffProgressLines(state: HandoffProgressState): string[] {
	const elapsedSec = Math.max(0, Math.floor((state.now - state.startedAt) / 1000));
	const stageLabel =
		state.stage === "summarizing" && state.model
			? `${HANDOFF_STAGE_LABELS.summarizing} · ${state.model}`
			: HANDOFF_STAGE_LABELS[state.stage];
	const footer = state.cancellable ? "Esc cancel" : "Finalizing…";
	const lines = [stageLabel];
	if (state.tokenSummary) lines.push(state.tokenSummary);
	lines.push(`${elapsedSec}s · ${footer}`);
	return lines;
}

export function tokenSummaryLine(
	record: Pick<HandoffRequestRecord, "tokenCounts">,
): string | undefined {
	if (!record.tokenCounts) return undefined;
	const total =
		record.tokenCounts.prefixTokens +
		record.tokenCounts.recentTokens +
		record.tokenCounts.historyTokens +
		record.tokenCounts.summaryReserve;
	return `${(total / 1000).toFixed(1)}k tokens`;
}

export function createHandoffProgressComponent(
	state: HandoffProgressState,
	theme: Theme,
): Component & { update(next: HandoffProgressState): void } {
	const text = new Text("");
	const paint = (next: HandoffProgressState): void => {
		text.setText(
			renderHandoffProgressLines(next)
				.map((line, index) => (index === 0 ? theme.bold(line) : theme.fg("dim", line)))
				.join("\n"),
		);
	};
	paint(state);
	const box = new Box(1, 0);
	box.addChild(text);
	return {
		invalidate: () => box.invalidate(),
		render: (width) => box.render(width),
		update(next) {
			paint(next);
			box.invalidate();
		},
	};
}

export function renderHandoffRequestCollapsed(
	record: HandoffRequestRecord,
	theme: Theme,
): Component {
	const glyph = isFailurePhase(record.phase) ? "!" : "◐";
	const counts = tokenSummaryLine(record);
	const title = counts
		? `${glyph} handoff · ${phaseLabel(record)} · ${counts}`
		: `${glyph} handoff · ${phaseLabel(record)}`;
	return colorLine(theme.bold(title), record, theme);
}

export function renderHandoffRequestExpanded(
	record: HandoffRequestRecord,
	_theme: Theme,
): Component {
	const lines = [`request ${record.requestId}`, `phase ${record.phase}`, `stage ${record.stage}`];
	if (record.model) lines.push(`model ${record.model}`);
	if (record.tokenCounts) {
		lines.push(
			`tokens prefix ${record.tokenCounts.prefixTokens} · recent ${record.tokenCounts.recentTokens} · history ${record.tokenCounts.historyTokens} · reserve ${record.tokenCounts.summaryReserve}`,
		);
	}
	if (record.reason) lines.push(record.reason);
	if (record.snapshot) lines.push(renderSnapshotPreview(record.snapshot));
	if (record.summary) lines.push(record.summary);
	const box = new Box(1, 0);
	box.addChild(new Text(lines.join("\n")));
	return box;
}

export function renderHandoffContextCollapsed(
	details: HandoffContextDetails,
	summary: string,
	theme: Theme,
): Component {
	const shortId = details.sourceSessionId.slice(0, 8);
	const first = firstSummaryLine(summary);
	const line = [
		`handoff from ${shortId} · ${details.model} · ${details.generatedAt}`,
		first,
		`history ${details.tokens.historyTokens} tokens · recent 5 · summary ${Math.ceil(summary.length / 4)} tokens`,
	]
		.filter((part) => part.length > 0)
		.join("\n");
	const box = new Box(1, 0);
	box.addChild(new Text(theme.bold(line)));
	return box;
}

export function renderHandoffContextExpanded(xml: string, theme: Theme): Component {
	const box = new Box(1, 0);
	box.addChild(new Text(theme.fg("customMessageText", xml)));
	return box;
}

export function renderHandoffAttemptCollapsed(
	record: HandoffAttemptRecord,
	theme: Theme,
): Component {
	const glyph = record.phase === "attempt-failed" ? "!" : "◐";
	const title =
		record.phase === "attempt-failed"
			? `${glyph} handoff · attempt failed`
			: `${glyph} handoff · attempt started`;
	return new Text(theme.bold(title));
}

function phaseLabel(record: HandoffRequestRecord): string {
	if (record.phase === "failed") {
		return record.failureCategory ? `${record.failureCategory} failed` : "failed";
	}
	if (record.phase === "snapshot-ready") return "snapshot ready";
	if (record.phase === "summary-ready") return "summary ready";
	if (record.phase === "replacement-started") return "replacement started";
	return record.phase;
}

function isFailurePhase(phase: HandoffRequestRecord["phase"]): boolean {
	return (
		phase === "failed" || phase === "cancelled" || phase === "interrupted" || phase === "superseded"
	);
}

function colorLine(line: string, record: HandoffRequestRecord, theme: Theme): Component {
	const container = new Container();
	container.addChild(new Text(isFailurePhase(record.phase) ? theme.fg("error", line) : line));
	return container;
}

function renderSnapshotPreview(snapshot: HandoffSourceContextSnapshot): string {
	return [
		`history ${snapshot.tokens.historyTokens} tokens`,
		`recent ${snapshot.recentMessages.length}`,
	].join(" · ");
}

export function renderHandoffRequest(
	entry: CustomEntry<HandoffRequestRecord>,
	options: EntryRenderOptions,
	theme: Theme,
): Component | undefined {
	const record = entry.data;
	if (!record) return undefined;
	return options.expanded
		? renderHandoffRequestExpanded(record, theme)
		: renderHandoffRequestCollapsed(record, theme);
}

export function renderHandoffAttempt(
	entry: CustomEntry<HandoffAttemptRecord>,
	options: EntryRenderOptions,
	theme: Theme,
): Component | undefined {
	const record = entry.data;
	if (!record) return undefined;
	if (!options.expanded) return renderHandoffAttemptCollapsed(record, theme);
	const lines = [
		`request ${record.requestId}`,
		`phase ${record.phase}`,
		`source ${record.sourcePath}`,
	];
	if (record.reason) lines.push(record.reason);
	const box = new Box(1, 0);
	box.addChild(new Text(lines.join("\n")));
	return box;
}

export const renderHandoffContext: MessageRenderer<HandoffContextDetails> = (
	message,
	options,
	theme,
) => {
	const details = message.details;
	if (!details) return undefined;
	const xml =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	const summary = extractSummary(xml);
	return options.expanded
		? renderHandoffContextExpanded(xml, theme)
		: renderHandoffContextCollapsed(details, summary, theme);
};

function extractSummary(xml: string): string {
	const start = xml.indexOf("<handoff-summary>");
	const end = xml.indexOf("</handoff-summary>");
	if (start < 0 || end < 0 || end <= start) return "";
	return xml.slice(start + "<handoff-summary>".length, end).trim();
}
