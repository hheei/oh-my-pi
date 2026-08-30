import { isRecord } from "#core/shared/record-type-guard";
import type { MessageLike } from "#core/hooks/tag-messages";
import { resolvePiStableId } from "./read-session-pi.ts";

type PiLkgMessageLike = MessageLike & { pi: unknown };

function piContentToParts(message: Record<string, unknown>): unknown[] {
	const role = message.role;
	if (role === "user") {
		if (typeof message.content === "string") {
			return [{ type: "text", text: message.content }];
		}
		return Array.isArray(message.content) ? [...message.content] : [];
	}
	if (role === "assistant") {
		if (!Array.isArray(message.content)) return [];
		return message.content.map((part) => {
			if (!isRecord(part)) return part;
			if (part.type === "toolCall") {
				return {
					type: "tool",
					id: part.id,
					callID: part.id,
					name: part.name,
					input: part.arguments,
				};
			}
			if (part.type === "thinking") {
				return { type: "thinking", thinking: part.thinking, text: part.thinking };
			}
			return part;
		});
	}
	if (role === "toolResult") {
		const content = Array.isArray(message.content) ? message.content : [];
		return [
			{
				type: "tool_result",
				tool_call_id: message.toolCallId,
				toolName: message.toolName,
				content,
				isError: message.isError === true,
			},
		];
	}
	return [];
}

function lkgRole(message: Record<string, unknown>): string {
	if (message.role === "toolResult") return "tool";
	return typeof message.role === "string" ? message.role : "user";
}

export function piMessagesToLkg(
	messages: readonly unknown[],
	options?: {
		entryIds?: readonly (string | undefined)[] | null;
		entryIdByRef?: ReadonlyMap<object, string> | null;
	},
): MessageLike[] {
	return messages.map((message, index) => {
		const rec = isRecord(message) ? message : {};
		const id =
			resolvePiStableId(message, index, options?.entryIds ?? undefined, options?.entryIdByRef ?? undefined) ??
			`pi-msg-${index}`;
		const created = typeof rec.timestamp === "number" ? rec.timestamp : 0;
		const stopReason = rec.stopReason;
		const providerID = typeof rec.provider === "string" ? rec.provider : undefined;
		const modelID = typeof rec.model === "string" ? rec.model : undefined;
		return {
			info: {
				id,
				role: lkgRole(rec),
				finish: stopReason === "toolUse" ? "tool-calls" : typeof stopReason === "string" ? stopReason : undefined,
				time: { created },
				providerID,
				modelID,
				model:
					providerID && modelID ? { providerID, modelID } : undefined,
			},
			parts: piContentToParts(rec),
			pi: message,
		};
	});
}

export function lkgMessagesToPi(messages: MessageLike[]): unknown[] {
	return messages.map((message, index) => {
		const wrapped = message as PiLkgMessageLike;
		if (wrapped.pi && typeof wrapped.pi === "object") return wrapped.pi;
		const info = message.info as { role?: string; id?: string } | undefined;
		const role = info?.role ?? "user";
		if (role === "tool") {
			const part = Array.isArray(message.parts) ? message.parts[0] : undefined;
			const rec = isRecord(part) ? part : {};
			return {
				role: "toolResult",
				toolCallId: rec.tool_call_id ?? rec.callID ?? `tool-${index}`,
				toolName: rec.toolName ?? "unknown",
				content: Array.isArray(rec.content) ? rec.content : [{ type: "text", text: "" }],
				isError: rec.isError === true,
				timestamp: 0,
			};
		}
		if (role === "assistant") {
			return {
				role: "assistant",
				content: Array.isArray(message.parts) ? message.parts : [],
				api: "openai",
				provider: "unknown",
				model: "unknown",
				usage: {},
				stopReason: "stop",
				timestamp: 0,
			};
		}
		const textPart = Array.isArray(message.parts)
			? message.parts.find((part) => isRecord(part) && part.type === "text")
			: undefined;
		return {
			role: "user",
			content: isRecord(textPart) && typeof textPart.text === "string" ? textPart.text : "",
			timestamp: 0,
		};
	});
}
