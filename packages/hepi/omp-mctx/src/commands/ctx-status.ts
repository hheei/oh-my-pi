import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { ContextDatabase } from "#core/features/storage";
import type { RecompProgress } from "#core/hooks/compartment-runner-types";
import { describeError } from "#core/shared/error-message";
import {
	buildStatusSections,
	collectStatusSnapshot,
	renderStatusMarkdown,
	showStatusDialog,
	type StatusSection,
	type StatusSnapshot,
} from "../dialogs/status-dialog";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export interface RegisterCtxStatusDeps {
	db: ContextDatabase;
	projectIdentity: string;
	resolveStatusDeps?: ((ctx: { cwd: string }) => CtxStatusRuntimeDeps) | undefined;
	resolveProject?:
	| ((ctx: { cwd: string }) => {
		projectDir: string;
		projectIdentity: string;
	})
	| undefined;
	protectedTags?: number | undefined;
	executeThresholdPercentage?: number | { default: number;[modelKey: string]: number } | undefined;
	historyBudgetPercentage?: number | undefined;
	injectionBudgetTokens?: number | undefined;
	executeThresholdTokens?:
	| {
		default?: number | undefined;
		[modelKey: string]: number | undefined;
	}
	| undefined;
	/** Existing process-local records; absent means progress is unknown. */
	/** Optional public branch identity; defaults to main when Pi exposes no branch id. */
	resolveBranchId?: ((ctx: ExtensionCommandContext) => string | undefined) | undefined;
	recompProgressBySession?: ReadonlyMap<string, RecompProgress> | undefined;
}

export type CtxStatusRuntimeDeps = Omit<RegisterCtxStatusDeps, "resolveStatusDeps">;

export type CtxStatusDetails = StatusSnapshot;

export function registerCtxStatusCommand(pi: ExtensionAPI, deps: RegisterCtxStatusDeps): void {
	pi.registerCommand("ctx-status", {
		description: "Show Magic Context status for the current Pi session",
		handler: async (_args, ctx) => {
			const runtimeDeps = deps.resolveStatusDeps?.(ctx) ?? deps;
			const projectIdentity =
				runtimeDeps.resolveProject?.(ctx).projectIdentity ?? runtimeDeps.projectIdentity;
			const currentDeps = { ...runtimeDeps, projectIdentity };
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-status",
					text: "## Magic Status\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}

			try {
				const snapshot = collectStatusSnapshot(pi, ctx, currentDeps, sessionId);
				const sections = buildStatusSections(snapshot);
				if (ctx.hasUI) {
					await showStatusDialog(pi, ctx, currentDeps, snapshot);
					return;
				}
				const markdown = renderStatusMarkdown(sections);
				const text = typeof pi.appendEntry === "function" ? markdown : renderHeadlessFallback(sections);
				sendCtxStatusMessage(
					pi,
					{ title: "/ctx-status", text, level: "info" },
					snapshot,
					{ log: typeof pi.appendEntry !== "function" },
				);
			} catch (error) {
				sendCtxStatusMessage(pi, {
					title: "/ctx-status",
					text: `## Magic Status — Failed\n\n${describeError(error).brief}`,
					level: "error",
				});
			}
		},
	});
}

function renderHeadlessFallback(sections: StatusSection[]): string {
	return renderStatusMarkdown(sections.map(section => ({
		...section,
		items: section.items.filter(item => !item.label.startsWith("Recall ") && item.label !== "Outbox error" && item.label !== "Bridge error"),
	})));
}
