import { describe, expect, it } from "bun:test";
import { withPlanModeUserLanguage } from "./user-language";

describe("withPlanModeUserLanguage", () => {
	it("appends the user-language directive after the upstream plan prompt", () => {
		const out = withPlanModeUserLanguage("Plan mode active.\n");
		expect(out.startsWith("Plan mode active.")).toBe(true);
		expect(out).toContain("same language as the user's request");
		expect(out).toContain("Context, Approach, Critical files & anchors, Verification, Assumptions & contingencies");
		expect(out.endsWith("\n")).toBe(true);
	});
});
