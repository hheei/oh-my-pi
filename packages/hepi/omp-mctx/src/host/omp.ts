export function asPromptText(prompt: string | string[] | undefined): string {
	if (prompt == null) return "";
	return Array.isArray(prompt) ? prompt.join("\n") : prompt;
}

export function asPromptParts(prompt: string): string[] {
	return [prompt];
}

export function undefNum(value: number | null | undefined): number | undefined {
	return value == null ? undefined : value;
}
