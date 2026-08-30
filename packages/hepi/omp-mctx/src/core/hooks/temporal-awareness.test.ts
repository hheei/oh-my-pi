import { describe, expect, test } from "bun:test";
import { injectTemporalMarkers } from "./temporal-awareness.ts";

const MIN = 60_000;

function msg(
	role: string,
	text: string,
	created: number,
	opts?: { completed?: number; ignored?: boolean },
) {
	return {
		info: { role, time: { created, ...(opts?.completed !== undefined ? { completed: opts.completed } : {}) } },
		parts: [{ type: "text", text, ...(opts?.ignored ? { ignored: true } : {}) }],
	};
}

describe("injectTemporalMarkers", () => {
	test("empty user text does not get a marker but still advances baseline", () => {
		const empty = msg("user", "   ", 0);
		const later = msg("user", "hello", 20 * MIN);
		expect(injectTemporalMarkers([empty, later])).toBe(1);
		expect(empty.parts[0]?.text).toBe("   ");
		expect(later.parts[0]?.text.startsWith("<!-- +")).toBe(true);
	});

	test("assistant completed time is the baseline for the next authored user", () => {
		const user = msg("user", "back", 20 * MIN);
		expect(injectTemporalMarkers([msg("assistant", "working", 0, { completed: MIN }), user])).toBe(1);
		expect(user.parts[0]?.text.startsWith("<!-- +")).toBe(true);
	});

	test("tool messages do not receive markers", () => {
		const tool = msg("tool", "log dump", 20 * MIN);
		expect(injectTemporalMarkers([msg("user", "go", 0), tool])).toBe(0);
		expect(tool.parts[0]?.text).toBe("log dump");
	});

	test("existing marker is idempotent", () => {
		const user = msg("user", "<!-- +12m -->\nalready", 20 * MIN);
		expect(injectTemporalMarkers([msg("user", "go", 0), user])).toBe(0);
		expect(user.parts[0]?.text).toBe("<!-- +12m -->\nalready");
	});

	test("missing timestamp skips injection", () => {
		const later = {
			info: { role: "user" },
			parts: [{ type: "text", text: "hello" }],
		};
		expect(injectTemporalMarkers([msg("user", "go", 0), later])).toBe(0);
		expect(later.parts[0]?.text).toBe("hello");
	});
});
