export const EMPTY_TASK_OUTPUT_SENTINEL = "<magic-context-empty-task-output>";
const EMPTY_COMPLETED_TASK_RESULT =
	/^<task\b[^>]*\bstate="completed"[^>]*>[\s\S]*<task_result>\s*<\/task_result>\s*<\/task>\s*$/;

const EMPTY_TASK_NOTE = `${EMPTY_TASK_OUTPUT_SENTINEL}
The subagent completed without a final text response. Context-fill truncation may have omitted its final output, or its provider may have emitted reasoning only; inspect the child session and retry with a low-reasoning model or variant.`;

export type ToolResultTextPart = { type?: string; text?: string };

function isEmptyCompletedTaskXml(text: string): boolean {
	if (text.includes(EMPTY_TASK_OUTPUT_SENTINEL)) return false;
	return EMPTY_COMPLETED_TASK_RESULT.test(text);
}

/**
 * OMP `tool_result` contract: returns a replacement content array.
 * The handler must `return { content }` — `ExtensionAPI.on("tool_result")`
 * accepts `ToolResultEventResult`. Do not mutate the event's array.
 */
export function annotateEmptyTaskOutputContent(
	toolName: string,
	content: ToolResultTextPart[],
): ToolResultTextPart[] | undefined {
	if (toolName !== "task" || !Array.isArray(content)) return undefined;
	const textParts = content.filter((part) => part?.type === "text" && typeof part.text === "string");
	const joined = textParts.map((part) => part.text as string).join("\n");
	if (!isEmptyCompletedTaskXml(joined)) return undefined;

	let replaced = false;
	return content.map((part) => {
		if (!replaced && part?.type === "text" && typeof part.text === "string") {
			replaced = true;
			return { ...part, text: `${joined}\n${EMPTY_TASK_NOTE}` };
		}
		return part;
	});
}
