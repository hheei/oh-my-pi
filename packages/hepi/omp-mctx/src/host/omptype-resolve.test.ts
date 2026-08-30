import { describe, expect, test } from "bun:test";

describe("omptype resolution", () => {
	test("resolves @oh-my-pi/omptype/typebox from this package", () => {
		const resolved = Bun.resolveSync("@oh-my-pi/omptype/typebox", import.meta.dir);
		expect(resolved).toContain("packages/omptype");
		expect(resolved.endsWith("typebox.ts") || resolved.includes("omptype")).toBe(true);
	});
});
