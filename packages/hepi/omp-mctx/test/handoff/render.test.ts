import { describe, expect, test } from "vitest";
import type { HandoffRequestRecord } from "../../src/handoff/model";
import {
	createHandoffProgressComponent,
	renderHandoffProgressLines,
	renderHandoffRequest,
	renderHandoffRequestCollapsed,
} from "../../src/handoff/render";

const theme = {
	bold: (value: string) => `*${value}*`,
	fg: (_name: string, value: string) => value,
};

describe("handoff render", () => {
	test("progress surface shows stage, tokens, and Esc until finalizing", () => {
		expect(
			renderHandoffProgressLines({
				stage: "summarizing",
				model: "anthropic/claude",
				tokenSummary: "12.0k tokens",
				startedAt: 0,
				now: 3500,
				cancellable: true,
			}),
		).toEqual(["Summarizing · anthropic/claude", "12.0k tokens", "3s · Esc cancel"]);
		expect(
			renderHandoffProgressLines({
				stage: "finalizing",
				startedAt: 0,
				now: 1000,
				cancellable: false,
			}),
		).toEqual(["Finalizing…", "1s · Finalizing…"]);
	});

	test("source request collapsed line uses the documented glyph and phase", () => {
		const record: HandoffRequestRecord = {
			requestId: "req-1",
			phase: "snapshot-ready",
			stage: "freezing",
			createdAt: "1",
			tokenCounts: {
				usableLimit: 1,
				executeCeiling: 1,
				prefixTokens: 1000,
				summaryReserve: 512,
				recentTokens: 200,
				historyTokens: 800,
				wrapperTokens: 50,
			},
		};
		const component = renderHandoffRequestCollapsed(record, theme as never);
		const lines = component.render(80);
		expect(lines.join("\n")).toContain("◐ handoff · snapshot ready");
		const registered = renderHandoffRequest(
			{ data: record } as never,
			{ expanded: false },
			theme as never,
		);
		expect(registered?.render(80).join("\n")).toContain("◐ handoff · snapshot ready");
	});

	test("progress component updates without changing size contract", () => {
		const component = createHandoffProgressComponent(
			{
				stage: "preparing",
				startedAt: 0,
				now: 0,
				cancellable: true,
			},
			theme as never,
		);
		const first = component.render(40);
		component.update({
			stage: "creating",
			startedAt: 0,
			now: 2000,
			cancellable: true,
		});
		const second = component.render(40);
		expect(first.length).toBeGreaterThan(0);
		expect(second.join("\n")).toContain("Creating continuation");
	});
});
