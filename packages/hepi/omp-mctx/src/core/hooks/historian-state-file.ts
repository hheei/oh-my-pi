import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePiArtifactGitignore, getProjectMagicContextHistorianDir } from "../shared/data-path";

/**
 * Historian state-file offloading.
 *
 * When the existing-state XML (prior compartments + facts + project memory)
 * exceeds {@link HISTORIAN_STATE_INLINE_THRESHOLD} characters, the historian
 * caller writes it to a temp file under the project-local historian dir
 * (`<project>/.pi/magic-context/historian/`) and the prompt instructs
 * the model to `Read this file first`. This avoids pushing 100K+ chars of
 * inline reference state through the model's input on long sessions.
 *
 * State is written inside `.pi/magic-context/` so Pi native tools can
 * read it without escaping the project boundary.
 *
 * The caller MUST delete the file in finally{} via
 * {@link cleanupHistorianStateFile}.
 *
 * Shared by the generic compartment runners and Pi's historian runner. The
 * directory is resolved from the project directory the caller passes in.
 */
export const HISTORIAN_STATE_INLINE_THRESHOLD = 30_000;

/**
 * When existingState is large, write it to a project-local file and return the
 * path. Returns undefined when existingState is small enough to inline OR when
 * writing fails (in which case the caller should fall back to inline).
 *
 * `directory` is the project directory; the helper writes under
 * `<directory>/.pi/magic-context/historian/`. The dir is created
 * recursively on first write.
 */
export function maybeWriteHistorianStateFile(
	sessionId: string,
	existingState: string,
	directory: string,
): string | undefined {
	if (existingState.length <= HISTORIAN_STATE_INLINE_THRESHOLD) return undefined;
	try {
		const dir = getProjectMagicContextHistorianDir(directory);
		mkdirSync(dir, { recursive: true });
		// Keep the transient dump dir out of the user's git status.
		ensurePiArtifactGitignore(directory);
		const path = join(dir, `state-${sessionId}-${Date.now()}.xml`);
		writeFileSync(path, existingState, "utf8");
		return path;
	} catch {
		return undefined;
	}
}

/** Delete a previously written state file. Safe to call with undefined. */
export function cleanupHistorianStateFile(path: string | undefined): void {
	if (!path) return;
	try {
		unlinkSync(path);
	} catch {
		// best-effort cleanup
	}
}
