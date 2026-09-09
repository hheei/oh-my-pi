import { describe, expect, it } from "vitest";

import {
	promptSyncWithModelSuggestionRetry,
	promptSyncWithValidatedOutputRetry,
} from "../../../src/core/shared/prompt-sync";

function modelNotFound(): Error {
	const error = new Error("model not found");
	error.name = "ProviderModelNotFoundError";
	(error as Error & { data: { providerID: string; suggestions: string[] } }).data = {
		providerID: "provider",
		suggestions: ["model"],
	};
	return error;
}

describe("prompt model suggestion retries", () => {
	it("does not retry the same suggestion indefinitely", async () => {
		let calls = 0;
		const client = {
			session: {
				prompt: async () => {
					calls++;
					throw modelNotFound();
				},
			},
		};

		await expect(promptSyncWithModelSuggestionRetry(client, { body: {} })).rejects.toThrow("model not found");
		expect(calls).toBe(2);
	});

	it("uses a provider suggestion for validated output retries", async () => {
		let calls = 0;
		const client = {
			session: {
				prompt: async () => {
					calls++;
					if (calls === 1) throw modelNotFound();
				},
			},
		};

		const result = await promptSyncWithValidatedOutputRetry(client, { body: {} }, {
			timeoutMs: 1000,
			callContext: "test",
			fetchOutput: async () => "ok",
			validateOutput: (output: string) => output,
		});

		expect(result).toEqual({ output: "ok", validated: "ok" });
		expect(calls).toBe(2);
	});
});
