import { describe, expect, test, vi } from "vitest";

import {
	promptSyncWithModelSuggestionRetry,
	promptSyncWithValidatedOutputRetry,
} from "../../../src/core/shared/prompt-sync";

type PromptCall = {
	body: {
		model?: { providerID: string; modelID: string };
		system?: string;
		[key: string]: unknown;
	};
	signal?: AbortSignal;
};

function promptArg(prompt: ReturnType<typeof vi.fn>, index: number): PromptCall {
	const calls = prompt.mock.calls as unknown as PromptCall[][];
	const arg = calls[index]?.[0];
	if (arg === undefined) throw new Error(`missing prompt call ${index}`);
	return arg;
}

function createClient(
	prompt: ReturnType<typeof vi.fn>,
	abort?: ReturnType<typeof vi.fn>,
	messages?: ReturnType<typeof vi.fn>,
) {
	return {
		session: {
			prompt,
			abort: abort ?? vi.fn(async () => ({})),
			messages: messages ?? vi.fn(async () => []),
		},
	} as never;
}

function createArgs(model?: { providerID: string; modelID: string }) {
	return {
		path: { id: "ses-test" },
		body: model ? { model } : {},
	};
}

describe("promptSyncWithModelSuggestionRetry", () => {
	test("primary succeeds, no fallback iteration", async () => {
		const prompt = vi.fn(async () => ({}));
		const client = createClient(prompt);

		await promptSyncWithModelSuggestionRetry(client, createArgs(), {
			fallbackModels: ["anthropic/claude-sonnet-4-6"],
		});

		expect(prompt).toHaveBeenCalledTimes(1);
	});

	test("primary succeeds with no fallbacks configured", async () => {
		const prompt = vi.fn(async () => ({}));
		const client = createClient(prompt);

		await promptSyncWithModelSuggestionRetry(client, createArgs());

		expect(prompt).toHaveBeenCalledTimes(1);
	});

	test("primary fails, fallback[0] succeeds", async () => {
		const prompt = vi.fn(async () => {
			if (prompt.mock.calls.length === 1) throw new Error("primary failed");
			return {};
		});
		const client = createClient(prompt);

		await promptSyncWithModelSuggestionRetry(client, createArgs(), {
			fallbackModels: ["anthropic/claude-sonnet-4-6"],
		});

		expect(prompt).toHaveBeenCalledTimes(2);
		expect(promptArg(prompt, 1).body.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-sonnet-4-6",
		});
	});

	test("primary fails, fallback[0] fails, fallback[1] succeeds", async () => {
		const prompt = vi.fn(async () => {
			if (prompt.mock.calls.length <= 2) throw new Error(`failed ${prompt.mock.calls.length}`);
			return {};
		});
		const client = createClient(prompt);

		await promptSyncWithModelSuggestionRetry(client, createArgs(), {
			fallbackModels: ["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"],
		});

		expect(prompt).toHaveBeenCalledTimes(3);
		expect(promptArg(prompt, 2).body.model).toEqual({
			providerID: "google",
			modelID: "gemini-3-flash",
		});
	});

	test("all attempts fail throws the last fallback error", async () => {
		const primaryError = new Error("primary failed");
		const firstFallbackError = new Error("fallback 0 failed");
		const lastFallbackError = new Error("fallback 1 failed");
		const errors = [primaryError, firstFallbackError, lastFallbackError];
		const prompt = vi.fn(async () => {
			throw errors[prompt.mock.calls.length - 1];
		});
		const client = createClient(prompt);

		await expect(
			promptSyncWithModelSuggestionRetry(client, createArgs(), {
				fallbackModels: ["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"],
			}),
		).rejects.toBe(lastFallbackError);
		expect(prompt).toHaveBeenCalledTimes(3);
	});

	test("abort signal short-circuits", async () => {
		const controller = new AbortController();
		controller.abort();
		const prompt = vi.fn(async () => {
			throw new Error("provider noticed abort");
		});
		const client = createClient(prompt);

		await expect(
			promptSyncWithModelSuggestionRetry(client, createArgs(), {
				signal: controller.signal,
				fallbackModels: ["anthropic/claude-sonnet-4-6"],
			}),
		).rejects.toThrow("prompt aborted by external signal");
		// Pre-aborted signal MUST short-circuit before any upstream prompt
		// call — Audit Finding #1 hardening. No round-trip wasted on a
		// request the caller has already cancelled.
		expect(prompt).toHaveBeenCalledTimes(0);
	});

	test("AbortError name short-circuits", async () => {
		const abortError = new Error("aborted by provider");
		abortError.name = "AbortError";
		const prompt = vi.fn(async () => {
			throw abortError;
		});
		const client = createClient(prompt);

		await expect(
			promptSyncWithModelSuggestionRetry(client, createArgs(), {
				fallbackModels: ["anthropic/claude-sonnet-4-6"],
			}),
		).rejects.toBe(abortError);
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	test("timeout short-circuits", async () => {
		const timeoutError = new Error("prompt timed out after 5000ms");
		const prompt = vi.fn(async () => {
			throw timeoutError;
		});
		const client = createClient(prompt);

		await expect(
			promptSyncWithModelSuggestionRetry(client, createArgs(), {
				fallbackModels: ["anthropic/claude-sonnet-4-6"],
			}),
		).rejects.toBe(timeoutError);
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	test("context overflow short-circuits", async () => {
		const overflowError = new Error("prompt is too long: 50000 tokens > 32000");
		const prompt = vi.fn(async () => {
			throw overflowError;
		});
		const client = createClient(prompt);

		await expect(
			promptSyncWithModelSuggestionRetry(client, createArgs(), {
				fallbackModels: ["anthropic/claude-sonnet-4-6"],
			}),
		).rejects.toBe(overflowError);
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	// #154: our timeout must force-stop the child's SERVER-SIDE run loop via
	// session.abort — cancelling our client fetch alone leaves the child looping
	// the LLM past the timeout (uncancellable, only dies on process exit).
	test("timeout fires session.abort on the child session", async () => {
		// A prompt that respects the AbortController by hanging until aborted,
		// then throwing — mirrors a real in-flight request our timeout cancels.
		const prompt = vi.fn((opts: { signal?: AbortSignal }) => {
			return new Promise((_resolve, reject) => {
				opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		});
		const abort = vi.fn(async () => ({}));
		const client = createClient(prompt as never, abort);

		await expect(
			promptSyncWithModelSuggestionRetry(client, createArgs(), { timeoutMs: 20 }),
		).rejects.toThrow(/timed out/);
		expect(abort).toHaveBeenCalledTimes(1);
		expect((abort.mock.calls as unknown as Array<[{ path: { id: string } }]>)[0]![0].path.id).toBe(
			"ses-test",
		);
	});

	// External abort (e.g. dreamer lease loss) mid-flight must also stop the
	// server-side loop, not just our fetch.
	test("external abort fires session.abort on the child session", async () => {
		const controller = new AbortController();
		const prompt = vi.fn((opts: { signal?: AbortSignal }) => {
			return new Promise((_resolve, reject) => {
				opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		});
		const abort = vi.fn(async () => ({}));
		const client = createClient(prompt as never, abort);

		setTimeout(() => controller.abort(), 10);
		await expect(
			promptSyncWithModelSuggestionRetry(client, createArgs(), { signal: controller.signal }),
		).rejects.toThrow(/aborted by external signal/);
		expect(abort).toHaveBeenCalledTimes(1);
		expect((abort.mock.calls as unknown as Array<[{ path: { id: string } }]>)[0]![0].path.id).toBe(
			"ses-test",
		);
	});

	// A failing session.abort must not mask the original timeout/abort error.
	test("session.abort failure does not mask the timeout error", async () => {
		const prompt = vi.fn((opts: { signal?: AbortSignal }) => {
			return new Promise((_resolve, reject) => {
				opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		});
		const abort = vi.fn(async () => {
			throw new Error("abort endpoint 500");
		});
		const client = createClient(prompt as never, abort);

		await expect(
			promptSyncWithModelSuggestionRetry(client, createArgs(), { timeoutMs: 20 }),
		).rejects.toThrow(/timed out/);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	test("suggestion retry within attempt succeeds", async () => {
		const suggestionError = new Error("model not found");
		suggestionError.name = "ProviderModelNotFoundError";
		Object.assign(suggestionError, {
			data: {
				providerID: "anthropic",
				modelID: "claude-sonnet-4-6",
				suggestions: ["claude-sonnet-4-7"],
			},
		});
		const prompt = vi.fn(async () => {
			if (prompt.mock.calls.length === 1) throw suggestionError;
			return {};
		});
		const client = createClient(prompt);

		await promptSyncWithModelSuggestionRetry(
			client,
			createArgs({ providerID: "anthropic", modelID: "claude-sonnet-4-6" }),
			{ fallbackModels: ["google/gemini-3-flash"] },
		);

		expect(prompt).toHaveBeenCalledTimes(2);
		expect(promptArg(prompt, 1).body.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-sonnet-4-7",
		});
	});

	test("invalid fallback specs are skipped", async () => {
		const prompt = vi.fn(async () => {
			if (prompt.mock.calls.length === 1) throw new Error("primary failed");
			return {};
		});
		const client = createClient(prompt);

		await promptSyncWithModelSuggestionRetry(client, createArgs(), {
			fallbackModels: ["no-slash", "/leading", "valid/model"],
		});

		expect(prompt).toHaveBeenCalledTimes(2);
		expect(promptArg(prompt, 1).body.model).toEqual({
			providerID: "valid",
			modelID: "model",
		});
	});

	test("iteration order respected", async () => {
		const prompt = vi.fn(async () => {
			throw new Error(`failed ${prompt.mock.calls.length}`);
		});
		const client = createClient(prompt);

		await expect(
			promptSyncWithModelSuggestionRetry(client, createArgs(), {
				fallbackModels: [
					"anthropic/claude-sonnet-4-6",
					"google/gemini-3-flash",
					"openrouter/qwen3-coder",
				],
			}),
		).rejects.toThrow("failed 4");

		expect(prompt).toHaveBeenCalledTimes(4);
		expect(prompt.mock.calls.map((_, i) => promptArg(prompt, i).body.model)).toEqual([
			undefined,
			{ providerID: "anthropic", modelID: "claude-sonnet-4-6" },
			{ providerID: "google", modelID: "gemini-3-flash" },
			{ providerID: "openrouter", modelID: "qwen3-coder" },
		]);
	});

	test("empty fallbackModels = legacy", async () => {
		const originalError = new Error("primary failed without suggestion");
		const prompt = vi.fn(async () => {
			throw originalError;
		});
		const client = createClient(prompt);

		await expect(
			promptSyncWithModelSuggestionRetry(client, createArgs(), { fallbackModels: [] }),
		).rejects.toBe(originalError);
		expect(prompt).toHaveBeenCalledTimes(1);
	});
});

describe("promptSyncWithValidatedOutputRetry", () => {
	test("valid first model returns without trying fallbacks", async () => {
		const prompt = vi.fn(async () => ({}));
		const messages = vi.fn(async () => "primary-output");
		const client = createClient(prompt, undefined, messages);

		const result = await promptSyncWithValidatedOutputRetry(client, createArgs(), {
			timeoutMs: 1_000,
			callContext: "test",
			fallbackModels: ["anthropic/claude-sonnet-4-6"],
			fetchOutput: async () => messages(),
			validateOutput: (output: unknown) => {
				const text = String(output);
				if (text.trim().length === 0) throw new Error("empty output");
				return text.trim();
			},
		});

		expect(result.validated).toBe("primary-output");
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(messages).toHaveBeenCalledTimes(1);
	});

	test("preserves body.system when a failed Pi-shaped attempt mutates its body", async () => {
		const prompt = vi.fn(async (args: PromptCall) => {
			if (prompt.mock.calls.length === 1) {
				// Reproduce a facade/SDK that consumes the request body before
				// rejecting the primary model. The fallback must not inherit
				// that mutation and spawn without its task prompt.
				delete args.body.system;
				throw new Error("primary failed");
			}
			return {};
		});
		const client = createClient(prompt);
		const systemPrompt = "CLASSIFY_SYSTEM_PROMPT";

		await promptSyncWithValidatedOutputRetry(
			client,
			{
				path: { id: "ses-classify" },
				body: {
					agent: "dreamer-classifier",
					system: systemPrompt,
					parts: [{ type: "text", text: "classify" }],
				},
			},
			{
				timeoutMs: 1_000,
				callContext: "test",
				fallbackModels: ["anthropic/claude-sonnet-4-6"],
				fetchOutput: async () => "fallback-output",
				validateOutput: (output: unknown) => String(output),
			},
		);

		expect(prompt).toHaveBeenCalledTimes(2);
		expect(promptArg(prompt, 0).body.system).toBeUndefined();
		expect(promptArg(prompt, 1).body.system).toBe(systemPrompt);
	});

	test("empty first model tries the next fallback", async () => {
		const prompt = vi.fn(async () => ({}));
		const messages = vi.fn(async () => (messages.mock.calls.length === 1 ? "" : "fallback-output"));
		const client = createClient(prompt, undefined, messages);

		const result = await promptSyncWithValidatedOutputRetry(client, createArgs(), {
			timeoutMs: 1_000,
			callContext: "test",
			fallbackModels: ["anthropic/claude-sonnet-4-6"],
			fetchOutput: async () => messages(),
			validateOutput: (output: unknown, attempt) => {
				const text = String(output);
				if (text.trim().length === 0) throw new Error(`empty output from ${attempt!.label}`);
				return text.trim();
			},
		});

		expect(result.validated).toBe("fallback-output");
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(messages).toHaveBeenCalledTimes(2);
		expect(promptArg(prompt, 1).body.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-sonnet-4-6",
		});
	});

	test("all empty outputs surface the original validation failure", async () => {
		const prompt = vi.fn(async () => ({}));
		const messages = vi.fn(async () => "");
		const client = createClient(prompt, undefined, messages);

		await expect(
			promptSyncWithValidatedOutputRetry(client, createArgs(), {
				timeoutMs: 1_000,
				callContext: "test",
				fallbackModels: ["anthropic/claude-sonnet-4-6"],
				fetchOutput: async () => messages(),
				validateOutput: (output: unknown, attempt) => {
					const text = String(output);
					if (text.trim().length === 0) {
						throw new Error(`empty output from ${attempt!.label}`);
					}
					return text.trim();
				},
			}),
		).rejects.toThrow("empty output from primary");

		expect(prompt).toHaveBeenCalledTimes(2);
		expect(messages).toHaveBeenCalledTimes(2);
	});
});
