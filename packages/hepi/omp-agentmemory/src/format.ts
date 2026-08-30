export type SmartSearchResult = {
	title?: string;
	narrative?: string;
	type?: string;
	combinedScore?: number;
	score?: number;
	observation?: {
		title?: string;
		narrative?: string;
		type?: string;
	};
};

export function formatSearchResults(results: SmartSearchResult[]): string {
	if (!results.length) return "No relevant memories found.";
	return results
		.slice(0, 5)
		.map((result, index) => {
			const obs = result.observation ?? result;
			const title = obs.title?.trim() || `Memory ${index + 1}`;
			const narrative = obs.narrative?.trim() || "";
			const type = obs.type?.trim() || "memory";
			const score = result.combinedScore ?? result.score;
			const scoreText = typeof score === "number" ? ` [score=${score.toFixed(3)}]` : "";
			return `- ${title} (${type})${scoreText}${narrative ? `: ${narrative}` : ""}`;
		})
		.join("\n");
}

export function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}
