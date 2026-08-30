/**
 * Pi `/ctx-aug` slash command.
 *
 * Validates sidekick configuration, notifies interactive users, runs the
 * sidekick subprocess, then queues either its augmentation or the original
 * prompt as a new Pi user message. Failures preserve the original prompt.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { withContentLanguageDirective } from "#core/agents/language-directive";
import { resolveProjectIdentityForSession } from "#core/features/memory/project-identity";
import {
	isEmptySidekickResult,
	SIDEKICK_SYSTEM_PROMPT,
	stripThinkingBlocks,
} from "#core/features/sidekick/core";
import { log, sessionLog } from "#core/shared/logger";

import { PiSubagentRunner } from "../subagent-runner";

/**
 * Configuration for Pi's sidekick agent.
 *
 * Pi needs a model identifier plus optional prompt and timeout overrides.
 */
export interface PiSidekickConfig {
	/** Provider/model identifier in `provider/model` form, e.g. `anthropic/claude-haiku-4-5`. */
	model: string;
	/** Override for sidekick system prompt. Defaults to SIDEKICK_SYSTEM_PROMPT. */
	systemPrompt?: string | undefined;
	/** Hard timeout in ms. Defaults to 30s — sidekick is expected to be fast. */
	timeoutMs?: number | undefined;
	/** Pi only: explicit thinking level (--thinking <level>) for sidekick subagent. */
	thinking_level?: string | undefined;
	/** Ordered fallback chain after the primary sidekick model. */
	fallbackModels?: readonly string[] | undefined;
	language?: string | undefined;
	/** Allow a session started exactly in the canonical home directory only when user-level configuration enables it. */
	allowHomeProject?: boolean | undefined;
}

type ResolveSidekickConfig = (ctx: { cwd: string }) => PiSidekickConfig | undefined;

/**
 * Register the `/ctx-aug` slash command on Pi.
 *
 * The command is a no-op when `config` is undefined (sidekick disabled in
 * config). Pi's command UI will still show the command but invoking it
 * will print a "not configured" message to the user.
 */
export function registerCtxAugCommand(
	pi: ExtensionAPI,
	config: PiSidekickConfig | undefined | ResolveSidekickConfig,
): void {
	const runner = new PiSubagentRunner();

	pi.registerCommand("ctx-aug", {
		description: "Augment your prompt with relevant project context (sidekick)",
		handler: async (args, ctx) => {
			const prompt = args.trim();

			// Use Pi's session entry IDs for log correlation. The session
			// manager's branch always has at least the current entry.
			const branch = ctx.sessionManager.getBranch();
			const lastEntryId = branch.length > 0 ? branch[branch.length - 1]?.id : "unknown";
			const sessionLabel = `pi-session-${lastEntryId}`;
			const currentConfig = typeof config === "function" ? config(ctx) : config;

			if (!currentConfig) {
				ctx.ui.notify(
					"/ctx-aug: Sidekick is not configured. Set the sidekick model in `/ext-settings`, then reload.",
					"warning",
				);
				return;
			}

			if (prompt.length === 0) {
				ctx.ui.notify(
					"/ctx-aug: Usage `/ctx-aug <your prompt>` — provide a prompt to augment with project memory context.",
					"info",
				);
				return;
			}

			// Inform the user. In print/rpc mode this is a no-op (hasUI=false),
			// which is correct: the user invoked /ctx-aug from a non-interactive
			// context and just wants the augmented turn to fire.
			if (ctx.hasUI) {
				ctx.ui.notify(
					"🔍 Preparing augmentation… 2-10s depending on your sidekick provider.",
					"info",
				);
			}

			sessionLog(sessionLabel, "/ctx-aug: spawning sidekick", {
				model: currentConfig.model,
			});

			// Spawn sidekick as a Pi subprocess. The subagent inherits the
			// current project's cwd so its tool calls (notably `ctx_search`)
			// resolve against the same project identity as the invoking
			// session. This lets the sidekick resolve project-scoped memory.
			const projectIdentity = resolveProjectIdentityForSession(
				ctx.cwd,
				currentConfig.allowHomeProject,
			);
			if (!projectIdentity) {
				sessionLog(sessionLabel, "Error: Could not resolve project identity for sidekick.");
				return;
			}
			sessionLog(sessionLabel, "/ctx-aug: project identity", projectIdentity);

			const result = await runner.run({
				agent: "sidekick",
				systemPrompt: withContentLanguageDirective(
					currentConfig.systemPrompt ?? SIDEKICK_SYSTEM_PROMPT,
					currentConfig.language,
				),
				userMessage: prompt,
				model: currentConfig.model,
				timeoutMs: currentConfig.timeoutMs ?? 30_000,
				cwd: ctx.cwd,
				...(currentConfig.fallbackModels === undefined
					? {}
					: { fallbackModels: currentConfig.fallbackModels }),
				...(currentConfig.thinking_level === undefined
					? {}
					: { thinkingLevel: currentConfig.thinking_level }),
				accountingSessionId: sessionLabel,
				accountingSubagent: "sidekick",
			});

			if (!result.ok) {
				// Failure modes: timeout, model_failed, spawn_failed, aborted, etc.
				// In all cases we still want the user's prompt to reach the agent —
				// the worst sidekick can do is fail silently, so we send the prompt
				// unaugmented and tell the user via UI notification (interactive
				// only).
				log(`[magic-context][pi] /ctx-aug: sidekick failed (${result.reason}): ${result.error}`);
				if (ctx.hasUI) {
					ctx.ui.notify(
						`/ctx-aug: sidekick failed (${result.reason}). Sending prompt without augmentation.`,
						"warning",
					);
				}
				pi.sendUserMessage(prompt);
				return;
			}

			const sidekickText = stripThinkingBlocks(result.assistantText);
			sessionLog(
				sessionLabel,
				`/ctx-aug: sidekick returned ${sidekickText.length} chars in ${result.durationMs}ms`,
			);

			// If sidekick returned the literal "no relevant memories" sentinel
			// (or near-empty text), skip the augmentation block entirely —
			// the agent gets a cleaner prompt.
			if (isEmptySidekickResult(sidekickText)) {
				pi.sendUserMessage(prompt);
				return;
			}

			const augmentedPrompt = `${prompt}\n\n<sidekick-augmentation>\n${sidekickText}\n</sidekick-augmentation>`;
			pi.sendUserMessage(augmentedPrompt);
		},
	});
}
