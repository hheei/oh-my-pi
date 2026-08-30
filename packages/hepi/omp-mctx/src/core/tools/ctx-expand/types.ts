import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

export interface CtxExpandArgs extends ImitatedReducedArgs {
	start?: number | undefined;
	end?: number | undefined;
	/** Verbose range view: each message + tool call shown separately, with ordinals. */
	verbose?: boolean | undefined;
	/** Full untruncated recovery of one message (any role) by its ordinal. */
	message?: number | undefined;
}
