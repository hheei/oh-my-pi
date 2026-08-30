import { describe, expect, it } from "vitest";
import { withContentLanguageDirective } from "../../../src/core/agents/language-directive";
import { buildMagicContextSection } from "../../../src/core/agents/magic-context-prompt";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "../../../src/core/hooks/compartment-prompt";

describe("Magic Context language guidance", () => {
	it("keeps guidance bytes unchanged when language is unset or blank", () => {
		const baseline = buildMagicContextSection(null, 20, true, true, false, false, false);
		expect(buildMagicContextSection(null, 20, true, true, false, false, false, undefined)).toBe(
			baseline,
		);
		expect(buildMagicContextSection(null, 20, true, true, false, false, false, "   ")).toBe(
			baseline,
		);
	});

	it("keeps historian prompt bytes unchanged when language is unset", () => {
		expect(
			withContentLanguageDirective(COMPARTMENT_AGENT_SYSTEM_PROMPT, undefined, {
				preserveUserQuotes: true,
			}),
		).toBe(COMPARTMENT_AGENT_SYSTEM_PROMPT);
	});

	it("adds deterministic primary language guidance when set", () => {
		const first = buildMagicContextSection(null, 20, true, true, false, false, false, "tr");
		const second = buildMagicContextSection(null, 20, true, true, false, false, false, "tr");
		const baseline = buildMagicContextSection(null, 20, true, true, false, false, false);

		expect(first).toBe(second);
		expect(first).toContain("Use Turkish (Türkçe) for your natural-language replies");
		expect(first.startsWith(baseline)).toBe(true);
	});
});
