import type { ParsedCompartment } from "./compartment-parser";
import type { CandidateCompartment } from "./compartment-runner-types";

/** Tier/metadata fields a parsed compartment may carry, threaded to storage. */
type ParsedTierFields = Pick<
	ParsedCompartment,
	"p1" | "p2" | "p3" | "p4" | "importance" | "episodeType"
>;

function tierFieldsOf(c: ParsedTierFields): ParsedTierFields {
	return {
		...(c.p1 === undefined ? {} : { p1: c.p1 }),
		...(c.p2 === undefined ? {} : { p2: c.p2 }),
		...(c.p3 === undefined ? {} : { p3: c.p3 }),
		...(c.p4 === undefined ? {} : { p4: c.p4 }),
		...(c.importance === undefined ? {} : { importance: c.importance }),
		...(c.episodeType === undefined ? {} : { episodeType: c.episodeType }),
	};
}

export function mapParsedCompartmentsToChunk(
	compartments: Array<
		{
			startMessage: number;
			endMessage: number;
			title: string;
			content: string;
		} & ParsedTierFields
	>,
	chunk: {
		startIndex: number;
		endIndex: number;
		lines: Array<{ ordinal: number; messageId: string }>;
	},
	sequenceOffset: number,
): { ok: true; compartments: CandidateCompartment[] } | { ok: false; error: string } {
	const mapped: CandidateCompartment[] = [];
	for (const [index, compartment] of compartments.entries()) {
		const startLine = chunk.lines.find((line) => line.ordinal === compartment.startMessage);
		const endLine = chunk.lines.find((line) => line.ordinal === compartment.endMessage);
		if (!startLine || !endLine) {
			return {
				ok: false,
				error: `Compartment range ${compartment.startMessage}-${compartment.endMessage} does not map to raw session lines ${chunk.startIndex}-${chunk.endIndex}`,
			};
		}
		mapped.push({
			sequence: sequenceOffset + index,
			startMessage: compartment.startMessage,
			endMessage: compartment.endMessage,
			startMessageId: startLine.messageId,
			endMessageId: endLine.messageId,
			title: compartment.title,
			content: compartment.content,
			...tierFieldsOf(compartment),
		});
	}

	return { ok: true, compartments: mapped };
}
