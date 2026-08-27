import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { OptimizerStatus } from "./status.ts";
import { editGuard, hasMalformedHashlineInput, hasStreamingApplyPatchCommand } from "./edit-guard.ts";

const historicalMalformedPayload = `[packages/hepi/omp-optimizer/src/index.ts#C557]\nPUT 2.=12:\n+const value = true;\n@@\nPUT 20.=20:\n+const next = false;`;

function callUpdate(
	handler: (event: unknown, context: { abort(): void }) => void,
	name: string,
	arguments_: Record<string, string>,
	abort: () => void,
): void {
	handler(
		{
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				partial: {
					content: [{ type: "toolCall", name, arguments: arguments_ }],
				},
			},
		},
		{ abort },
	);
}

function makeGuard(activeTools: readonly string[] = ["edit"]) {
	const handlers = new Map<string, (event: unknown, context?: { abort(): void }) => unknown>();
	const messages: unknown[] = [];
	const pi = {
		events: {},
		on(event: string, handler: (event: unknown, context?: { abort(): void }) => unknown) {
			handlers.set(event, handler);
		},
		getActiveTools: () => [...activeTools],
		sendMessage(message: unknown) {
			messages.push(message);
		},
	};
	editGuard(pi as unknown as ExtensionAPI, { set: () => {} } as unknown as OptimizerStatus);
	return { handlers, messages };
}

describe("edit guard detection", () => {
	it("matches historical bare @@ hashline failures", () => {
		expect(hasMalformedHashlineInput(historicalMalformedPayload)).toBe(true);
	});

	it("matches shell apply_patch commands but not plain mentions", () => {
		expect(hasStreamingApplyPatchCommand("apply_patch <<'PATCH'\n...")).toBe(true);
		expect(hasStreamingApplyPatchCommand("please do not use apply_patch")).toBe(false);
	});

	it("ignores valid hashline bodies and other edit formats", () => {
		expect(hasMalformedHashlineInput("[src/a.ts#ABCD]\nPUT 1.=1:\n+const marker = '@@';")).toBe(false);
		expect(hasMalformedHashlineInput("[src/a.ts#ABCD]\nPUT 1.=1:\n+@@")).toBe(false);
		expect(hasMalformedHashlineInput("*** Begin Patch\n*** Update File: src/a.ts\n@@ -1 +1 @@")).toBe(false);
		expect(hasMalformedHashlineInput("please avoid @@ when editing")).toBe(false);
	});
});

describe("edit guard runtime", () => {
	it("aborts malformed hashline once, then sends retry guidance", () => {
		const { handlers, messages } = makeGuard();
		const update = handlers.get("message_update") as (event: unknown, context: { abort(): void }) => void;
		const settled = handlers.get("agent_end") as (event: { willContinue?: boolean }, context: unknown) => void;
		let aborts = 0;

		callUpdate(update, "edit", { input: historicalMalformedPayload }, () => {
			aborts += 1;
		});
		callUpdate(update, "edit", { input: `${historicalMalformedPayload}\n@@` }, () => {
			aborts += 1;
		});
		expect(aborts).toBe(1);

		settled({ willContinue: false }, {});
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({
			customType: "edit-guard",
			content: expect.stringContaining("Do not retry the same payload"),
			display: true,
		});
	});

	it("aborts unavailable shell apply_patch and names active edit alternative", () => {
		const { handlers, messages } = makeGuard(["edit"]);
		const update = handlers.get("message_update") as (event: unknown, context: { abort(): void }) => void;
		const settled = handlers.get("agent_end") as (event: { willContinue?: boolean }, context: unknown) => void;
		let aborts = 0;

		callUpdate(update, "bash", { command: "apply_patch <<'PATCH'\n..." }, () => {
			aborts += 1;
		});
		expect(aborts).toBe(1);
		settled({ willContinue: false }, {});
		expect(messages[0]).toEqual({
			customType: "edit-guard",
			content: expect.stringContaining("Continue with `edit`"),
			display: true,
		});
	});

	it("does not block apply_patch when tool is active", () => {
		const { handlers } = makeGuard(["apply_patch", "edit"]);
		const update = handlers.get("message_update") as (event: unknown, context: { abort(): void }) => void;
		let aborts = 0;
		callUpdate(update, "bash", { command: "apply_patch <<'PATCH'\n..." }, () => {
			aborts += 1;
		});
		expect(aborts).toBe(0);
	});
});
