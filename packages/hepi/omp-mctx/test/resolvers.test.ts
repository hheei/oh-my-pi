import { describe, expect, it } from "vitest";
import { MagicContextConfigSchema } from "#core/config/schema/magic-context";
import {
	resolveDreamerFromConfig,
	resolveHistorianFromConfig,
	resolveSidekickFromConfig,
} from "../src/index";

describe("Pi config resolvers", () => {
	it("returns undefined for historian, dreamer, and sidekick when disabled", () => {
		const config = MagicContextConfigSchema.parse({
			historian: { disable: true, model: "test/historian" },
			dreamer: { disable: true, model: "test/dreamer" },
			sidekick: { disable: true, model: "test/sidekick" },
		});

		expect(resolveHistorianFromConfig(config)).toBeUndefined();
		expect(resolveDreamerFromConfig(config)).toBeUndefined();
		expect(resolveSidekickFromConfig(config)).toBeUndefined();
	});
});
