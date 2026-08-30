import { modelBodyField } from "./resolve-fallbacks";

type PromptClient = {
	session: {
		prompt(args: unknown): Promise<unknown>;
		abort?(args: unknown): Promise<unknown>;
	};
};

type RetryOptions = {
	fallbackModels?: readonly string[] | undefined;
	signal?: AbortSignal | undefined;
	timeoutMs?: number | undefined;
};

function stopRetry(error: unknown, signal: AbortSignal | undefined): boolean {
	if (signal?.aborted) return true;
	if (!(error instanceof Error)) return false;
	return (
		error.name === "AbortError" ||
		error.name === "TimeoutError" ||
		/timed out|timeout|prompt is too long|context overflow/i.test(error.message)
	);
}

function abortError(): Error {
	return new Error("prompt aborted by external signal");
}

function suggestionModels(error: unknown): string[] {
	const value = error as {
		name?: unknown | undefined;
		message?: unknown | undefined;
		data?: { providerID?: unknown; suggestions?: unknown };
	};
	if (value.name !== "ProviderModelNotFoundError" && value.message !== "model not found") return [];
	const providerID = typeof value.data?.providerID === "string" ? value.data.providerID : undefined;
	const suggestions = value.data?.suggestions;
	return Array.isArray(suggestions)
		? suggestions
				.filter((item): item is string => typeof item === "string")
				.map((item) => (item.includes("/") || !providerID ? item : `${providerID}/${item}`))
		: [];
}

function modelParts(model: string | undefined): Record<string, unknown> {
	return typeof model === "string" && model.includes("/") ? modelBodyField(model) : {};
}

async function promptAttempt(
	client: PromptClient,
	args: Record<string, unknown>,
	options: RetryOptions,
): Promise<void> {
	if (options.signal?.aborted) throw abortError();
	const controller = new AbortController();
	const onAbort = () => {
		controller.abort();
		if (client.session.abort) void client.session.abort({ path: args.path }).catch(() => undefined);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const prompt = client.session.prompt({ ...args, signal: controller.signal });
		const timeout =
			options.timeoutMs === undefined
				? undefined
				: new Promise<never>((_, reject) => {
						timer = setTimeout(async () => {
							const error = new Error(`prompt timed out after ${options.timeoutMs}ms`);
							error.name = "TimeoutError";
							reject(error);
							controller.abort();
							void client.session.abort?.({ path: args.path }).catch(() => undefined);
						}, options.timeoutMs);
					});
		await ((await timeout) ? Promise.race([prompt, timeout]) : prompt);
	} catch (error) {
		if (options.signal?.aborted) throw abortError();
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export async function promptSyncWithModelSuggestionRetry(
	client: PromptClient,
	args: { body?: Record<string, unknown> } & Record<string, unknown>,
	options: RetryOptions = {},
): Promise<void> {
	const queue = [
		undefined,
		...(options.fallbackModels ?? []).filter((model) => Boolean(modelParts(model).model)),
	] as (string | undefined)[];
	let lastError: unknown;
	for (let index = 0; index < queue.length; index += 1) {
		const model = queue[index];
		try {
			const body = { ...args.body, ...modelParts(model) };
			await promptAttempt(client, { ...args, body }, options);
			return;
		} catch (error) {
			lastError = error;
			if (stopRetry(error, options.signal))
				throw error instanceof Error && options.signal?.aborted ? abortError() : error;
			const suggestions = suggestionModels(error);
			if (suggestions.length) queue.splice(index + 1, 0, ...suggestions);
		}
	}
	throw lastError ?? new Error("prompt failed");
}

export async function promptSyncWithValidatedOutputRetry<Output, Validated>(
	client: PromptClient,
	args: { body?: Record<string, unknown> } & Record<string, unknown>,
	options: RetryOptions & {
		timeoutMs: number;
		callContext: string;
		fetchOutput: () => Promise<Output>;
		validateOutput: (output: Output, attempt?: { label: string }) => Validated;
	},
): Promise<{ output: Output; validated: Validated }> {
	const queue = [
		undefined,
		...(options.fallbackModels ?? []).filter((model) => Boolean(modelParts(model).model)),
	] as (string | undefined)[];
	let lastError: unknown;
	let firstValidationError: unknown;
	for (let index = 0; index < queue.length; index += 1) {
		const model = queue[index];
		const label = model ?? "primary";
		try {
			await promptAttempt(
				client,
				{ ...args, body: { ...args.body, ...modelParts(model) } },
				options,
			);
			const output = await options.fetchOutput();
			return { output, validated: options.validateOutput(output, { label }) };
		} catch (error) {
			lastError = error;
			if (
				firstValidationError === undefined &&
				error instanceof Error &&
				/empty output/.test(error.message)
			)
				firstValidationError = error;
			if (stopRetry(error, options.signal))
				throw error instanceof Error && options.signal?.aborted ? abortError() : error;
		}
	}
	throw firstValidationError ?? lastError ?? new Error(`${options.callContext}: prompt failed`);
}
