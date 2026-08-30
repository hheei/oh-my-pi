import { type ContextDatabase, updateTagMessageId } from "../features/storage";

import type { Tagger } from "../features/tagger";

type TaggableContentType = "message" | "file";

interface ScopedAssignment {
	tagNumber: number;
	contentId: string;
	partIndex: number;
}

type ScopedAssignments = Record<TaggableContentType, ScopedAssignment[]>;

interface ParsedContentId {
	messageId: string;
	type: TaggableContentType;
	partIndex: number;
}

export interface ExistingTagResolver {
	resolve: (
		messageId: string,
		type: TaggableContentType,
		currentContentId: string,
		ordinal: number,
	) => number | undefined;
}

function parseScopedContentId(contentId: string): ParsedContentId | null {
	const match = /^(.*):(p|file)(\d+)$/.exec(contentId);
	if (!match) return null;
	const [messageId, type, partIndex] = [match[1], match[2], match[3]];
	if (messageId === undefined || type === undefined || partIndex === undefined) return null;

	return {
		messageId,
		type: type === "file" ? "file" : "message",
		partIndex: Number.parseInt(partIndex, 10),
	};
}

function createScopedAssignments(
	assignments: ReadonlyMap<string, number>,
): Map<string, ScopedAssignments> {
	const scoped = new Map<string, ScopedAssignments>();

	for (const [contentId, tagNumber] of assignments) {
		const parsed = parseScopedContentId(contentId);
		if (!parsed) continue;

		const entry = scoped.get(parsed.messageId) ?? { message: [], file: [] };
		entry[parsed.type].push({ tagNumber, contentId, partIndex: parsed.partIndex });
		scoped.set(parsed.messageId, entry);
	}

	for (const entry of scoped.values()) {
		entry.message.sort((left, right) => left.partIndex - right.partIndex);
		entry.file.sort((left, right) => left.partIndex - right.partIndex);
	}

	return scoped;
}

export function createExistingTagResolver(
	sessionId: string,
	tagger: Tagger,
	db: ContextDatabase,
): ExistingTagResolver {
	const assignments = tagger.getAssignments(sessionId);
	let cachedAssignmentSize = -1;
	let cachedScopedAssignments: Map<string, ScopedAssignments> | null = null;
	const usedTagNumbers = new Set<number>();

	function getScopedAssignments(): Map<string, ScopedAssignments> {
		if (!cachedScopedAssignments || cachedAssignmentSize !== assignments.size) {
			cachedScopedAssignments = createScopedAssignments(assignments);
			cachedAssignmentSize = assignments.size;
		}

		return cachedScopedAssignments;
	}

	return {
		resolve(messageId, type, currentContentId, ordinal) {
			const exactTagId = assignments.get(currentContentId);
			if (exactTagId !== undefined) {
				usedTagNumbers.add(exactTagId);
				return exactTagId;
			}

			const fallback = getScopedAssignments().get(messageId)?.[type][ordinal];
			if (!fallback || usedTagNumbers.has(fallback.tagNumber)) {
				return undefined;
			}

			updateTagMessageId(db, sessionId, fallback.tagNumber, currentContentId);
			tagger.unbindTag(sessionId, fallback.contentId);
			tagger.bindTag(sessionId, currentContentId, fallback.tagNumber);
			usedTagNumbers.add(fallback.tagNumber);
			return fallback.tagNumber;
		},
	};
}
