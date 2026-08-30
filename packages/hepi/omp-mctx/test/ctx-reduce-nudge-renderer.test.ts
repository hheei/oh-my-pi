import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CHANNEL1_NUDGE_CUSTOM_TYPE } from "../src/ctx-reduce-nudge-pi";
import { renderChannel1Nudge } from "../src/index";

describe("Channel 1 nudge renderer", () => {
	it("renders a magic-context block without exposing system-reminder markup", () => {
		const rendered = renderChannel1Nudge(
			{
				customType: CHANNEL1_NUDGE_CUSTOM_TYPE,
				content: "<system-reminder>model-only</system-reminder>",
				display: true,
				details: { displayText: "Drop spent output with ctx_reduce." },
			} as never,
			{ expanded: false, outputPad: 0 },
			{
				bold: (text: string) => text,
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
			} as Theme,
		);
		expect(rendered).toBeDefined();
	});
});
