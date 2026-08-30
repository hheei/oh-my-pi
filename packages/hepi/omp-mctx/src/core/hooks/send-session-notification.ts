import { getErrorMessage } from "../shared/error-message";
import { sessionLog } from "../shared/logger";

export interface NotificationParams {
	agent?: string | undefined;
	variant?: string | undefined;
	providerId?: string | undefined;
	modelId?: string | undefined;
}

export type NotificationDeliveryDisposition = "sent" | "queued" | "skipped" | "failed";

/**
 * Notifications are status lines, not user input. Keep only the newest entries
 * while a real turn is active so a long background run cannot grow memory or
 * manufacture a backlog of user rows at the next idle boundary.
 */
export const MAX_QUEUED_IGNORED_NOTIFICATIONS = 16;

interface QueuedIgnoredNotification {
	client: unknown;
	sessionId: string;
	text: string;
	params: NotificationParams;
	forcePersist: boolean;
}

const queuedIgnoredNotifications = new Map<string, QueuedIgnoredNotification[]>();
const flushingIgnoredNotifications = new Set<string>();
let midTurnDetector: (sessionId: string) => boolean = () => false;

function queueIgnoredNotification(notification: QueuedIgnoredNotification): void {
	const queued = queuedIgnoredNotifications.get(notification.sessionId) ?? [];
	queued.push(notification);
	if (queued.length > MAX_QUEUED_IGNORED_NOTIFICATIONS) {
		queued.splice(0, queued.length - MAX_QUEUED_IGNORED_NOTIFICATIONS);
		sessionLog(
			notification.sessionId,
			`ignored notification queue full; dropped oldest entries (kept newest ${MAX_QUEUED_IGNORED_NOTIFICATIONS})`,
		);
	}
	queuedIgnoredNotifications.set(notification.sessionId, queued);
}

/** Test seams for the process-local queue; production uses the Pi session-state signal. */
export const __ignoredNotificationTest = {
	pendingTexts(sessionId: string): string[] {
		return (queuedIgnoredNotifications.get(sessionId) ?? []).map((item) => item.text);
	},
	reset(): void {
		queuedIgnoredNotifications.clear();
		flushingIgnoredNotifications.clear();
		midTurnDetector = (): boolean => false;
	},
	setMidTurnDetector(detector: (sessionId: string) => boolean): void {
		midTurnDetector = detector;
	},
};

interface NotificationClient {
	session?:
		| {
				messages?: (query: { limit: number }) => Promise<{
					data?: Array<{ info?: Record<string, unknown> }>;
				}>;
				prompt?: ((opts: unknown) => unknown | Promise<unknown>) | undefined;
				promptAsync?: ((opts: unknown) => Promise<unknown>) | undefined;
		  }
		| undefined;
}

function hasNotificationSessionClient(client: unknown): client is NotificationClient {
	if (client === null || typeof client !== "object") return false;
	const candidate = client as Record<string, unknown>;
	if (candidate.session === undefined) return true;
	if (candidate.session === null || typeof candidate.session !== "object") return false;
	const session = candidate.session as Record<string, unknown>;
	return (
		(session.prompt === undefined || typeof session.prompt === "function") &&
		(session.promptAsync === undefined || typeof session.promptAsync === "function")
	);
}

async function sendIgnoredMessageNow(
	client: unknown,
	sessionId: string,
	text: string,
	params: NotificationParams,
	forcePersist: boolean,
): Promise<NotificationDeliveryDisposition> {
	// A final active-run check closes the window created by the title/context
	// lookups below. The normal caller checks before entering this function too.
	if (midTurnDetector(sessionId)) {
		queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
		return "queued";
	}

	// Title-safety guard (issue #129): an ignored message is hidden from the
	// LLM but not `synthetic`, so Pi title generation counts it as a real
	// user message. Do not persist into a not-yet-titled session because that
	// permanently suppresses title generation.
	const { waitForSafeNotificationTarget } = await import("../shared/safe-notification-target");
	if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") {
		sessionLog(sessionId, "notification skipped (session not titled yet)");
		return "skipped";
	}

	// Check again immediately before constructing the prompt. This prevents an
	// active run that began during title lookup from receiving a new user row.
	if (midTurnDetector(sessionId)) {
		queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
		return "queued";
	}

	if (!hasNotificationSessionClient(client)) {
		sessionLog(sessionId, "session prompt API unavailable for notification");
		return "failed";
	}
	const c = client;

	let agent = params.agent || undefined;
	let variant = params.variant || undefined;
	let providerId = params.providerId;
	let modelId = params.modelId;
	if ((!agent || !providerId || !modelId) && c.session?.messages) {
		const messages = await c.session.messages({ limit: 50 });
		const lastAssistant = [...(messages.data ?? [])]
			.reverse()
			.find((message) => message.info?.role === "assistant")?.info;
		agent ||= typeof lastAssistant?.agent === "string" ? lastAssistant.agent : undefined;
		variant ||= typeof lastAssistant?.variant === "string" ? lastAssistant.variant : undefined;
		providerId ||=
			typeof lastAssistant?.providerID === "string" ? lastAssistant.providerID : undefined;
		modelId ||= typeof lastAssistant?.modelID === "string" ? lastAssistant.modelID : undefined;
	}
	const input = {
		path: { id: sessionId },
		body: {
			agent,
			variant,
			model: providerId && modelId ? { providerID: providerId, modelID: modelId } : undefined,
			noReply: true,
			parts: [
				{
					type: "text",
					text,
					ignored: true,
				},
			],
		},
	};

	try {
		if (typeof c.session?.prompt === "function") {
			await Promise.resolve(c.session.prompt(input));
			return "sent";
		}
		if (typeof c.session?.promptAsync === "function") {
			await c.session.promptAsync(input);
			return "sent";
		}
		sessionLog(sessionId, "session prompt API unavailable for notification");
		return "failed";
	} catch (error: unknown) {
		const msg = getErrorMessage(error);
		sessionLog(sessionId, "failed to send notification:", msg);
		return "failed";
	}
}

export async function sendIgnoredMessage(
	client: unknown,
	sessionId: string,
	text: string,
	params: NotificationParams,
	forcePersist = false,
): Promise<NotificationDeliveryDisposition> {
	// Pi appends ignored rows to the session transcript. Do not create one
	// while the assistant is mid-turn.
	if (midTurnDetector(sessionId)) {
		queueIgnoredNotification({ client, sessionId, text, params, forcePersist });
		return "queued";
	}

	return sendIgnoredMessageNow(client, sessionId, text, params, forcePersist);
}

/**
 * Flush queued status lines after an event that may have made the session idle.
 * The event hook and tool.execute.after both call this; the same DB-backed gate
 * remains authoritative, so a non-idle event is harmless.
 */
export async function flushIgnoredMessages(sessionId: string): Promise<void> {
	if (flushingIgnoredNotifications.has(sessionId) || midTurnDetector(sessionId)) return;
	const queued = queuedIgnoredNotifications.get(sessionId);
	if (!queued || queued.length === 0) return;

	queuedIgnoredNotifications.delete(sessionId);
	flushingIgnoredNotifications.add(sessionId);
	try {
		for (const notification of queued) {
			const disposition = await sendIgnoredMessage(
				notification.client,
				notification.sessionId,
				notification.text,
				notification.params,
				notification.forcePersist,
			);
			if (disposition === "queued") {
				// The current item is already re-queued by sendIgnoredMessage.
				// Preserve the remaining entries behind it in their original order.
				for (const remaining of queued.slice(queued.indexOf(notification) + 1)) {
					queueIgnoredNotification(remaining);
				}
				break;
			}
		}
	} finally {
		flushingIgnoredNotifications.delete(sessionId);
	}
}

export function clearIgnoredMessages(sessionId: string): void {
	queuedIgnoredNotifications.delete(sessionId);
	flushingIgnoredNotifications.delete(sessionId);
}

/**
 * Send a real user prompt that will be processed by the model (not ignored).
 * Used by /ctx-aug to inject the augmented prompt after sidekick completes.
 */
export async function sendUserPrompt(
	client: unknown,
	sessionId: string,
	text: string,
): Promise<void> {
	if (!hasNotificationSessionClient(client)) {
		sessionLog(sessionId, "session prompt API unavailable for user prompt");
		return;
	}
	const c = client as NotificationClient;

	const input = {
		path: { id: sessionId },
		body: {
			parts: [{ type: "text", text }],
		},
	};

	try {
		if (typeof c.session?.promptAsync === "function") {
			await c.session.promptAsync(input);
		} else if (typeof c.session?.prompt === "function") {
			await Promise.resolve(c.session.prompt(input));
		} else {
			sessionLog(sessionId, "session prompt API unavailable for user prompt");
		}
	} catch (error: unknown) {
		const msg = getErrorMessage(error);
		sessionLog(sessionId, "failed to send user prompt:", msg);
	}
}
