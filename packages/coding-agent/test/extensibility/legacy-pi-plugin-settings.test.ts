import { describe, expect, it } from "bun:test";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

describe("legacy shim plugin settings export", () => {
	it("re-exports getPluginSettings from the legacy package root", () => {
		expect(typeof getPluginSettings).toBe("function");
	});
});
