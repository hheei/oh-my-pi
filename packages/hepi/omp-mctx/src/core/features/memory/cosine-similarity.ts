export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) {
		return 0;
	}

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let index = 0; index < a.length; index++) {
		const aValue = a[index] ?? 0;
		const bValue = b[index] ?? 0;
		dotProduct += aValue * bValue;
		normA += aValue * aValue;
		normB += bValue * bValue;
	}

	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	return denominator === 0 ? 0 : dotProduct / denominator;
}
