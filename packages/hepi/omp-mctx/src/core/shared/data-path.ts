import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function getDataDir(): string {
	return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

export function getMagicContextTempDir(): string {
	return path.join(os.tmpdir(), "omp", "magic-context");
}

export function getMagicContextLogPath(): string {
	const envPath = process.env.MAGIC_CONTEXT_LOG_PATH?.trim();
	if (envPath) return envPath;
	return path.join(getMagicContextTempDir(), "magic-context.log");
}

export function getMagicContextHistorianDir(): string {
	return path.join(getMagicContextTempDir(), "historian");
}

/** Project-local transient artifacts, readable by OMP native tools. */
export function getProjectMagicContextDir(directory: string): string {
	return path.join(directory, ".omp", "magic-context");
}

/** Project-local historian response dumps. */
export function getProjectMagicContextHistorianDir(directory: string): string {
	return path.join(getProjectMagicContextDir(directory), "historian");
}

const GITIGNORE_GUARD_OPEN = "# >>> omp:magic-context";
const GITIGNORE_GUARD_CLOSE = "# <<< omp:magic-context";

/** Keep transient artifacts out of version control without touching other entries. */
export function ensurePiArtifactGitignore(directory: string): void {
	try {
		const ompDir = path.join(directory, ".omp");
		const gitignorePath = path.join(ompDir, ".gitignore");
		let existing = "";
		if (existsSync(gitignorePath)) {
			existing = readFileSync(gitignorePath, "utf8");
			if (existing.includes(GITIGNORE_GUARD_OPEN)) return;
		}
		const block = `${GITIGNORE_GUARD_OPEN}\nmagic-context/\n${GITIGNORE_GUARD_CLOSE}\n`;
		const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
		mkdirSync(ompDir, { recursive: true });
		writeFileSync(gitignorePath, existing + (needsLeadingNewline ? "\n" : "") + block, "utf8");
	} catch {
		// Artifact writes retain their own failure handling.
	}
}

export function getMagicContextStorageDir(): string {
	const testDataDir =
		process.env.NODE_ENV === "test"
			? process.env.XDG_DATA_HOME?.trim() || process.env.MAGIC_CONTEXT_TEST_DATA_DIR?.trim()
			: undefined;
	if (testDataDir) return path.join(testDataDir, "extensions", "omp-mctx");

	const agentDir =
		process.env.OMP_CODING_AGENT_DIR?.trim() ||
		process.env.PI_CODING_AGENT_DIR?.trim() ||
		path.join(os.homedir(), ".omp", "agent");
	return path.join(agentDir, "extensions", "omp-mctx");
}
