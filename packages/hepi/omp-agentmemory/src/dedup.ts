import crypto from "node:crypto";

const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const recentHashes = new Map<string, number>();

export function isDuplicate(data: string): boolean {
	const hash = crypto.createHash("sha256").update(data).digest("hex");
	const now = Date.now();
	const prev = recentHashes.get(hash);
	if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) return true;
	if (recentHashes.size > 500) {
		for (const [key, ts] of recentHashes) {
			if (now - ts >= DEDUP_WINDOW_MS) recentHashes.delete(key);
		}
	}
	recentHashes.set(hash, now);
	return false;
}

export function resetDedup(): void {
	recentHashes.clear();
}
