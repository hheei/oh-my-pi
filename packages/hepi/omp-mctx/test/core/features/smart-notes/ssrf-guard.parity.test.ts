import { describe, expect, test } from "vitest";

import { validateSmartNoteHttpUrl } from "../../../../src/core/features/smart-notes/ssrf-guard";

describe("smart-note SSRF guard runtime parity", () => {
	test("classifies public IPv4 as allowed and mixed private answers as blocked", async () => {
		const allowed = await validateSmartNoteHttpUrl("https://example.test/", {
			signal: new AbortController().signal,
			resolver: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
		}).then(
			() => true,
			() => false,
		);
		const blocked = await validateSmartNoteHttpUrl("https://example.test/", {
			signal: new AbortController().signal,
			resolver: {
				lookup: async () => [
					{ address: "93.184.216.34", family: 4 },
					{ address: "10.0.0.1", family: 4 },
				],
			},
		}).then(
			() => false,
			() => true,
		);
		expect(allowed).toBe(true);
		expect(blocked).toBe(true);
	});
});
