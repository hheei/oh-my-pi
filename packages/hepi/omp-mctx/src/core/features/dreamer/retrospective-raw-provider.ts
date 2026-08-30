export interface RetrospectiveRawMessage {
	sessionId: string;
	ordinal: number;
	role: "user" | "assistant" | "tool";
	text: string;
	ts: number;
	toolName?: string | undefined;
}

export interface RetrospectiveProjectSession {
	sessionId: string;
	path?: string | undefined;
	updatedAt?: number | undefined;
}

export interface RetrospectiveSinceRead {
	messages: RetrospectiveRawMessage[];
	truncated: boolean;
}

export interface RetrospectiveRawProvider {
	listProjectSessions(
		projectIdentity: string,
	): RetrospectiveProjectSession[] | Promise<RetrospectiveProjectSession[]>;
	readUserMessagesSince(
		sessionId: string,
		sinceMs: number,
		capPerSession: number,
	): RetrospectiveSinceRead | Promise<RetrospectiveSinceRead>;
	readUserMessagesBefore(
		sessionId: string,
		beforeMs: number,
		count: number,
	): RetrospectiveRawMessage[] | Promise<RetrospectiveRawMessage[]>;
	readOldestMessageTimesSince?(
		sessionIds: readonly string[],
		sinceMs: number,
	): Map<string, number> | Promise<Map<string, number>>;
}

export interface RetrospectiveScanOptions {
	maxMessagesPerRun?: number | undefined;
	capPerSession?: number | undefined;
	maxSessionsPerRun?: number | undefined;
}

export interface RetrospectiveScanWindow {
	messages: RetrospectiveRawMessage[];
	maxScannedTs: number;
}

const DEFAULT_MAX_MESSAGES_PER_RUN = 200;
const DEFAULT_CAP_PER_SESSION = 100;
const DEFAULT_MAX_SESSIONS_PER_RUN = 20;

function compareMessages(left: RetrospectiveRawMessage, right: RetrospectiveRawMessage): number {
	return (
		left.ts - right.ts ||
		left.sessionId.localeCompare(right.sessionId) ||
		left.ordinal - right.ordinal
	);
}

function dedupeMessages(messages: RetrospectiveRawMessage[]): RetrospectiveRawMessage[] {
	const seen = new Set<string>();
	return messages.filter((message) => {
		const key = `${message.sessionId}:${message.ts}:${message.ordinal}:${message.role}:${message.text}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export async function readRetrospectiveScanWindow(
	provider: RetrospectiveRawProvider,
	projectIdentity: string,
	sinceMs: number,
	overlapCount: number,
	options: RetrospectiveScanOptions = {},
): Promise<RetrospectiveScanWindow> {
	const maxMessages = Math.max(
		1,
		Math.floor(options.maxMessagesPerRun ?? DEFAULT_MAX_MESSAGES_PER_RUN),
	);
	const capPerSession = Math.max(1, Math.floor(options.capPerSession ?? DEFAULT_CAP_PER_SESSION));
	const maxSessions = Math.max(
		1,
		Math.floor(options.maxSessionsPerRun ?? DEFAULT_MAX_SESSIONS_PER_RUN),
	);
	const sessions = await provider.listProjectSessions(projectIdentity);
	const oldestBySession = provider.readOldestMessageTimesSince
		? await provider.readOldestMessageTimesSince(
				sessions.map((session) => session.sessionId),
				sinceMs,
			)
		: new Map<string, number>();
	const candidates = provider.readOldestMessageTimesSince
		? sessions.filter((session) => oldestBySession.has(session.sessionId))
		: sessions;
	const ordered = candidates
		.slice()
		.sort(
			(left, right) =>
				(oldestBySession.get(left.sessionId) ?? left.updatedAt ?? Number.MAX_SAFE_INTEGER) -
					(oldestBySession.get(right.sessionId) ?? right.updatedAt ?? Number.MAX_SAFE_INTEGER) ||
				left.sessionId.localeCompare(right.sessionId),
		);
	const selected = ordered.slice(0, maxSessions);
	const excludedOldest = ordered
		.slice(maxSessions)
		.map((session) => oldestBySession.get(session.sessionId))
		.filter((timestamp): timestamp is number => timestamp !== undefined);

	const reads = await Promise.all(
		selected.map(async (session) => ({
			sessionId: session.sessionId,
			since: await provider.readUserMessagesSince(session.sessionId, sinceMs, capPerSession),
			overlap:
				sinceMs > 0 && overlapCount > 0
					? await provider.readUserMessagesBefore(session.sessionId, sinceMs, overlapCount)
					: [],
		})),
	);
	const newMessages = reads.flatMap((read) => read.since.messages).sort(compareMessages);
	const keptNewMessages = newMessages.slice(0, maxMessages);
	const droppedNewMessages = newMessages.slice(maxMessages);
	const overlapMessages = reads.flatMap((read) => read.overlap);
	const messages = dedupeMessages([...overlapMessages, ...keptNewMessages]).sort(compareMessages);

	let maxScannedTs = keptNewMessages.at(-1)?.ts ?? sinceMs;
	const clamps: number[] = [];
	const firstDropped = droppedNewMessages[0];
	if (firstDropped) clamps.push(firstDropped.ts - 1);
	for (const read of reads) {
		if (!read.since.truncated) continue;
		const lastKept = read.since.messages.at(-1);
		if (lastKept) clamps.push(lastKept.ts - 1);
	}
	for (const oldest of excludedOldest) clamps.push(oldest - 1);
	if (clamps.length > 0) maxScannedTs = Math.min(maxScannedTs, ...clamps);

	return { messages, maxScannedTs };
}
