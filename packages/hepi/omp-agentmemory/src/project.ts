import { execFileSync } from "node:child_process";
import path from "node:path";

const cache = new Map<string, string>();

export function resolveProjectName(dir: string, explicit?: string): string {
	const fromEnv = explicit?.trim() || process.env.AGENTMEMORY_PROJECT_NAME?.trim();
	if (fromEnv) return fromEnv;
	const cached = cache.get(dir);
	if (cached) return cached;
	let name = path.basename(dir) || dir;
	try {
		const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: dir,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		}).trim();
		if (top) name = path.basename(top);
	} catch {
		// not a git repo
	}
	cache.set(dir, name);
	return name;
}

export function clearProjectNameCache(): void {
	cache.clear();
}
