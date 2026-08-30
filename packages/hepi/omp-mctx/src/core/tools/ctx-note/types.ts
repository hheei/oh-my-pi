import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

export type CtxNoteReadFilter = "all" | "active" | "pending" | "ready" | "dismissed";

export interface CtxNoteArgs extends ImitatedReducedArgs {
	action?: "write" | "read" | "dismiss" | "update" | undefined;
	content?: string | undefined;
	surface_condition?: string | undefined;
	filter?: CtxNoteReadFilter | undefined;
	/** Max notes per section for read, newest first (default 25). */
	limit?: number | undefined;
	/** Skip this many newest notes for read — pages older ones (default 0). */
	offset?: number | undefined;
	note_id?: number | undefined;
}
