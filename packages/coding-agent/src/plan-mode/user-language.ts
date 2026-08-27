import planModeLanguagePrompt from "../prompts/system/plan-mode-language.md" with { type: "text" };

/**
 * Fork-owned plan-mode language overlay.
 *
 * Upstream `plan-mode-active.md` is an English execution spec with English
 * section headings and an "another engineer" audience, so models write the
 * plan in English even when the user asked in another language. Append the
 * overlay after the upstream prompt so the body follows the user.
 */
export function withPlanModeUserLanguage(planPrompt: string): string {
	const extra = planModeLanguagePrompt.trim();
	if (!extra) return planPrompt;
	return `${planPrompt.trimEnd()}\n\n${extra}\n`;
}
