type TextBlock = { type?: string; text?: string };
type ChatMessage = { role?: string; content?: unknown };

export function getText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [] as string[];
			const block = part as TextBlock;
			if (block.type === "text" && typeof block.text === "string") return [block.text];
			return [] as string[];
		})
		.join("\n")
		.trim();
}

export function getLastAssistantText(messages: unknown[]): string {
	for (const msg of [...messages].reverse()) {
		if (!msg || typeof msg !== "object") continue;
		const assistant = msg as ChatMessage;
		if (assistant.role !== "assistant") continue;
		const text = getText(assistant.content);
		if (text) return text;
	}
	return "";
}

export function jsonText(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
