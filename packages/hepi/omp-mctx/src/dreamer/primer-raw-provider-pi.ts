import type { RawMessageProvider } from "#core/hooks/read-session-chunk";
import type { RawMessage } from "#core/hooks/read-session-raw";
import { convertEntriesToRawMessages } from "../read-session-pi";
import { loadDefaultPiSessionApi, type PiSessionApi } from "./pi-session-api";

/**
 * Pi `primerRawProviderFactory`: resolve a historical session id to a
 * `RawMessageProvider` over its JSONL, so refresh-primers can render the
 * orientation seed on Pi-only installs.
 *
 * Discovery is async (listSessions / loadEntriesFromFile), so this returns a
 * Promise; the produced provider's `readMessages()` is synchronous (it wraps the
 * already-loaded RawMessage[]). Returns null when the session can't be resolved
 * or has no entries → refresh-primers falls back to closed-book for that primer.
 */
export interface PiPrimerRawProviderDeps {
	listSessions?: ((sessionDir?: string) => unknown[] | Promise<unknown[]>) | undefined;
	loadEntriesFromFile?: ((filePath: string) => unknown[] | Promise<unknown[]>) | undefined;
	sessionDir?: string | undefined;
}

interface PiSessionInfoLike {
	id?: unknown | undefined;
	path?: unknown | undefined;
}

export function createPiPrimerRawProviderFactory(
	deps: PiPrimerRawProviderDeps = {},
): (sessionId: string) => Promise<RawMessageProvider | null> {
	let resolved: Promise<PiSessionApi> | null = null;

	const resolveDeps = async () => {
		if (deps.listSessions && deps.loadEntriesFromFile) {
			return {
				listSessions: deps.listSessions,
				loadEntriesFromFile: deps.loadEntriesFromFile,
			};
		}
		resolved ??= loadDefaultPiSessionApi();
		return resolved;
	};

	return async (sessionId: string): Promise<RawMessageProvider | null> => {
		try {
			const { listSessions, loadEntriesFromFile } = await resolveDeps();
			const sessions = (await listSessions(deps.sessionDir)) as PiSessionInfoLike[];
			const match = sessions.find(
				(s) => s && typeof s === "object" && s.id === sessionId && typeof s.path === "string",
			);
			if (!match || typeof match.path !== "string") return null;
			const entries = await loadEntriesFromFile(match.path);
			const messages = convertEntriesToRawMessages(entries);
			if (messages.length === 0) return null;
			return {
				readMessages(): RawMessage[] {
					return messages;
				},
				getMessageCount() {
					return messages.length;
				},
			};
		} catch {
			return null;
		}
	};
}
