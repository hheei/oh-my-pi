import { describe, expect, test } from "bun:test";
import { buildMagicContextSection } from "./magic-context-prompt";

describe("Magic Context tool guidance", () => {
	test("omits unavailable note and search tool guidance", () => {
		const prompt = buildMagicContextSection(
			null,
			20,
			true,
			false,
			false,
			false,
			false,
			undefined,
			false,
			false,
			false,
		);

		expect(prompt).not.toContain("ctx_note");
		expect(prompt).not.toContain("ctx_search");
		expect(prompt).not.toContain("ctx_memory");
		expect(prompt).toContain("ctx_expand");
		expect(prompt).toContain("ctx_reduce");
	});

	test("keeps enabled note and search guidance", () => {
		const prompt = buildMagicContextSection(null, 20, true, false, false, false, false);
		expect(prompt).toContain("ctx_note");
		expect(prompt).toContain("ctx_search");
	});

	test("disables search guidance without disabling note guidance", () => {
		const prompt = buildMagicContextSection(
			null,
			20,
			true,
			false,
			false,
			false,
			false,
			undefined,
			false,
			false,
			true,
		);
		expect(prompt).not.toContain("ctx_search");
		expect(prompt).toContain("ctx_note");
	});

	test("disables note guidance without disabling search guidance", () => {
		const prompt = buildMagicContextSection(
			null,
			20,
			true,
			false,
			false,
			false,
			false,
			undefined,
			false,
			true,
			false,
		);
		expect(prompt).toContain("ctx_search");
		expect(prompt).not.toContain("project memories");
		expect(prompt).not.toContain("ctx_note");
	});
});
