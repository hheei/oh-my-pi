import type { Database } from "../../shared/sqlite";
import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

/** Sources the agent can narrow ctx_search to. Facts are intentionally NOT a
 *  source — they're always rendered in <session-history> in message[0], so
 *  searching them returns content already visible in context. */
export type CtxSearchSource = "memory" | "message" | "git_commit" | "primer" | "note";

export interface CtxSearchArgs extends ImitatedReducedArgs {
	query?: string | undefined;
	limit?: number | undefined;
	/** Restrict search to specific sources. Omit to search all; [] searches none. */
	sources?: CtxSearchSource[] | undefined;
}

export interface CtxSearchToolDeps {
	db: Database;
	ensureProjectRegistered?: ((directory: string, db: Database) => Promise<void>) | undefined;
	/**
	 * Resolve the project identity for the session's directory at call time.
	 * See CtxMemoryToolDeps.resolveProjectPath for why this is a function:
	 * Session-level working directory may differ from project identity; use the
	 * session's working directory.
	 */
	resolveProjectPath: (directory: string) => string | undefined;
	memoryEnabled?: boolean | undefined;
	embeddingEnabled?: boolean | undefined;
	/** When true, ctx_search surfaces indexed git commits as a 3rd source. */
	gitCommitsEnabled?: boolean | undefined;
	/** Override message reader for testing without a provider store. */
	readMessages?:
		| ((sessionId: string) => Array<{
				ordinal: number;
				id: string;
				role: string;
				parts: unknown[];
		  }>)
		| undefined;
}
