import type { Database } from "../shared/sqlite";

interface ChildSessionClient {
	session: { create(input: never): unknown | Promise<unknown> };
}

interface ChildSessionSpawnArgs {
	client: ChildSessionClient;
	db: Database | null;
	parentSessionId?: string | undefined;
	title: string;
	directory?: string | undefined;
}

/**
 * Shared child-session choke point. Every historian/recomp, dreamer, and
 * sidekick child passes through this Pi facade.
 */
export async function createChildSessionWithFence(
	args: ChildSessionSpawnArgs,
): Promise<unknown | null> {
	return args.client.session.create({
		body: {
			...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
			title: args.title,
		},
		query: { directory: args.directory },
	} as never);
}
