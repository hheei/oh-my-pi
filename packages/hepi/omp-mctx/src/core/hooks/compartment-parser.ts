export interface ParsedCompartment {
	startMessage: number;
	endMessage: number;
	title: string;
	/** v2: P1 tier text (mirror). v1/flat: the flat compartment body. */
	content: string;
	/** v2 paraphrase tiers (model B). Undefined for v1/flat compartments. p4 may be "" (self-close). */
	p1?: string | undefined;
	p2?: string | undefined;
	p3?: string | undefined;
	p4?: string | undefined;
	/** v2 decay-rate signal (1-100). Undefined for v1/flat. */
	importance?: number | undefined;
	/** v2 comma-separated activity types. Undefined for v1/flat. */
	episodeType?: string | undefined;
}

export interface ParsedFact {
	category: string;
	content: string;
}

/**
 * A historian-extracted event (v2). Two kinds today — `causal_incident` and
 * `trajectory_correction` — but parsed kind-agnostically: `kind` is the element
 * name and `fields` holds every child element verbatim. v2.0 STORES events
 * (E2 events table) but does NOT render them; parsing kind-agnostically means a
 * future event-kind or field addition needs no parser change.
 */
export interface ParsedEvent {
	kind: string;
	/** 1-based compartment index the event anchors to (`at_compartment="N"`); null if absent/invalid. */
	atCompartment: number | null;
	/** child element name → text content (e.g. summary, before_strategy, evidence). */
	fields: Record<string, string>;
}

export interface ParsedPrimerCandidate {
	question: string;
	/** 1-based index into the publish's emitted compartments
	 *  (`<primer at_compartment="N">`), matching the SAME convention as
	 *  `<events>` anchoring. Undefined for the legacy bullet form, in which case
	 *  emission falls back to the chunk span. */
	originCompartmentIndex?: number | undefined;
}

export interface ParsedCompartmentOutput {
	compartments: ParsedCompartment[];
	facts: ParsedFact[];
	events: ParsedEvent[];
	unprocessedFrom: number | null;
	userObservations: string[];
	primerCandidates: ParsedPrimerCandidate[];
}

// Open tag captured separately from body so attributes (start/end/title/
// episode_type/importance) can appear in ANY order — LLM output is not
// attribute-order-stable. Group 1 = full attribute string, group 2 = inner body.
const COMPARTMENT_REGEX = /<compartment\s+([^>]*?)\s*>(.*?)<\/compartment>/gs;
// Self-closing v2 compartments are invalid (a compartment must have ≥1 tier or
// flat content), so we only match the paired form above.
const ATTR_START_REGEX = /\bstart="(\d+)"/;
const ATTR_END_REGEX = /\bend="(\d+)"/;
const ATTR_TITLE_REGEX = /\btitle="([^"]*)"/;
const ATTR_EPISODE_REGEX = /\bepisode_type="([^"]*)"/;
const ATTR_IMPORTANCE_REGEX = /\bimportance="(\d+)"/;
// Per-tier opener: matches `<p1>` / `<p1 >` (group 1 empty) or the self-close
// `<p1/>` / `<p1 />` (group 1 = "/", P4 only → ""). The body that follows an
// opener is bounded procedurally in extractTier rather than by an exact `</pN>`
// close, because some models mismatch the closing digit (e.g. `<p1>…</p2>`).
function makeTierOpenRegex(n: number): RegExp {
	return new RegExp(`<p${n}\\s*(/?)>`);
}
const TIER_OPEN_REGEXES = [
	makeTierOpenRegex(1),
	makeTierOpenRegex(2),
	makeTierOpenRegex(3),
	makeTierOpenRegex(4),
];
// Any tier's closing tag (`</p1>`…`</p9>`) — used to bound an opened tier's body
// regardless of whether the close digit matches the opener.
const TIER_CLOSE_ANY_REGEX = /<\/p\d/;
// Any tier's OPENING tag (`<p1>`…`<p9>`) — the over-capture guard: a tier body
// must never swallow a following tier's opener.
const TIER_OPEN_ANY_REGEX = /<p\d/;
// v2 world taxonomy (5 categories). The historian emits only these; legacy 9-cat
// names are accepted at the ctx_memory layer (E3 aliases), not here.
const CATEGORY_BLOCK_REGEX =
	/<(PROJECT_RULES|ARCHITECTURE|CONSTRAINTS|CONFIG_VALUES|NAMING)>(.*?)<\/\1>/gs;
const FACT_ITEM_REGEX = /^\s*\*\s*(.+)$/gm;
const UNPROCESSED_REGEX = /<unprocessed_from>(\d+)<\/unprocessed_from>/;
const USER_OBSERVATIONS_REGEX = /<user_observations>(.*?)<\/user_observations>/s;
const USER_OBS_ITEM_REGEX = /^\s*\*\s*(.+)$/gm;
const PRIMER_CANDIDATES_REGEX = /<primer_candidates>(.*?)<\/primer_candidates>/s;
// Preferred form: <primer at_compartment="N">question</primer>, where N is the
// `start` ordinal of the origin compartment (reuses the ordinal the historian is
// already emitting on each <compartment start="N">). The legacy bullet form
// (*/-/1.) is still accepted and falls back to the chunk span at emission.
const PRIMER_ELEMENT_REGEX = /<primer\s+at_compartment="(\d+)"\s*>(.*?)<\/primer>/gs;
const PRIMER_ITEM_REGEX = /^\s*(?:\*|-|\d+\.)\s*(.+)$/gm;

// Events: scan the <events>…</events> block (if any) for event elements. Kinds
// are parsed kind-agnostically — any element with an `at_compartment` attr is an
// event whose child elements become `fields`. v2.0 stores events; rendering is
// deferred (E2). Scoping to the <events> block prevents fact/compartment tags
// from being mis-read as events.
const FACTS_BLOCK_REGEX = /<facts>(.*?)<\/facts>/s;
const EVENTS_BLOCK_REGEX = /<events>(.*?)<\/events>/s;
const EVENT_ELEMENT_REGEX = /<([a-z_]+)\s+at_compartment="(\d+)"\s*>(.*?)<\/\1>/gs;
const EVENT_FIELD_REGEX = /<([a-z_]+)\s*>(.*?)<\/\1>/gs;

function capture(match: readonly (string | undefined)[], index: number): string | undefined {
	return match[index];
}

function optionalCompartmentMetadata(
	importance: number | undefined,
	episodeType: string | undefined,
): Pick<ParsedCompartment, "importance" | "episodeType"> {
	return {
		...(importance === undefined ? {} : { importance }),
		...(episodeType === undefined ? {} : { episodeType }),
	};
}

/**
 * Extract a single tier body from a compartment inner string.
 *
 * Lenient about the close: an opened `<pN>` is terminated by the NEXT closing
 * tier tag of ANY digit (`</p\d>`), because some models mismatch the close
 * (observed: `<p1>…</p2>`). If the model omitted the close entirely, the next
 * opening tier tag — or the end of the compartment — bounds the body instead.
 *
 * Returns:
 *  - string (possibly "") when the <pN> element is present ("" = self-close or empty)
 *  - undefined when the element is absent entirely
 */
function extractTier(inner: string, index: number): string | undefined {
	const openRegex = TIER_OPEN_REGEXES[index];
	if (!openRegex) return undefined;
	const openMatch = openRegex.exec(inner);
	if (!openMatch) return undefined;
	// Self-close form (<p4/> or <p4 />) → empty tier.
	if (openMatch[1] === "/") return "";
	const rest = inner.slice(openMatch.index + openMatch[0].length);
	// Bound the body at the next closing tier tag (any digit). When there is no
	// close at all, run to the end of the compartment and let the guard below
	// trim at the next opener if one is present.
	const closeAt = rest.search(TIER_CLOSE_ANY_REGEX);
	let body = closeAt === -1 ? rest : rest.slice(0, closeAt);
	// Over-capture guard: never swallow a subsequent tier's opening tag into
	// this tier's content. If an opener appears before the close, cut there.
	const openInside = body.search(TIER_OPEN_ANY_REGEX);
	if (openInside !== -1) body = body.slice(0, openInside);
	return unescapeXml(body.trim());
}

/**
 * Extract all four tier bodies from a compartment's inner markup using the
 * lenient closing rules above. Exposed for the v70 heal migration, which
 * re-parses flat `content` that the old strict parser stranded as legacy when a
 * model mismatched a tier's closing tag. Each tier is undefined when absent.
 */
export function extractTiersFromInner(inner: string): {
	p1?: string | undefined;
	p2?: string | undefined;
	p3?: string | undefined;
	p4?: string | undefined;
} {
	const p1 = extractTier(inner, 0);
	const p2 = extractTier(inner, 1);
	const p3 = extractTier(inner, 2);
	const p4 = extractTier(inner, 3);
	return {
		...(p1 === undefined ? {} : { p1 }),
		...(p2 === undefined ? {} : { p2 }),
		...(p3 === undefined ? {} : { p3 }),
		...(p4 === undefined ? {} : { p4 }),
	};
}

export function parseCompartmentOutput(text: string): ParsedCompartmentOutput {
	const compartments: ParsedCompartment[] = [];
	const facts: ParsedFact[] = [];

	for (const match of text.matchAll(COMPARTMENT_REGEX)) {
		const attrs = capture(match, 1);
		const inner = capture(match, 2);
		if (attrs === undefined || inner === undefined) continue;

		const startMatch = attrs.match(ATTR_START_REGEX);
		const endMatch = attrs.match(ATTR_END_REGEX);
		const titleMatch = attrs.match(ATTR_TITLE_REGEX);
		if (!startMatch || !endMatch || !titleMatch) continue;

		const startRaw = capture(startMatch, 1);
		const endRaw = capture(endMatch, 1);
		const titleRaw = capture(titleMatch, 1);
		if (startRaw === undefined || endRaw === undefined || titleRaw === undefined) continue;
		const startMessage = parseInt(startRaw, 10);
		const endMessage = parseInt(endRaw, 10);
		const title = unescapeXml(titleRaw);
		if (Number.isNaN(startMessage) || Number.isNaN(endMessage) || !title) continue;

		const episodeMatch = attrs.match(ATTR_EPISODE_REGEX);
		const importanceMatch = attrs.match(ATTR_IMPORTANCE_REGEX);
		const episodeRaw = episodeMatch ? capture(episodeMatch, 1) : undefined;
		const importanceRaw = importanceMatch ? capture(importanceMatch, 1) : undefined;
		const episodeType = episodeRaw === undefined ? undefined : unescapeXml(episodeRaw);
		const importance = importanceRaw === undefined ? undefined : parseInt(importanceRaw, 10);
		const metadata = optionalCompartmentMetadata(importance, episodeType);

		// v2 tiered shape: at least <p1> present.
		const p1 = extractTier(inner, 0);
		if (typeof p1 === "string" && p1.length > 0) {
			const p2 = extractTier(inner, 1);
			const p3 = extractTier(inner, 2);
			const p4 = extractTier(inner, 3);
			compartments.push({
				startMessage,
				endMessage,
				title,
				content: p1, // content mirrors P1 (fullest tier) for v2 rows
				p1,
				// Fall back denser→denser for any missing middle tier so storage
				// always has 4 non-undefined tiers; p4 may legitimately be "".
				p2: typeof p2 === "string" ? p2 : p1,
				p3: typeof p3 === "string" ? p3 : typeof p2 === "string" ? p2 : p1,
				p4: typeof p4 === "string" ? p4 : "",
				...metadata,
			});
			continue;
		}

		// v1/flat shape (compressor output, legacy, or historian that didn't emit tiers).
		const content = unescapeXml(inner.trim());
		if (content) {
			compartments.push({
				startMessage,
				endMessage,
				title,
				content,
				...metadata,
			});
		}
	}

	// Scope category extraction to the <facts> block. Category tags
	// (PROJECT_RULES, ARCHITECTURE, …) can legitimately appear inside <events>
	// field text or compartment bodies; scanning the whole response would
	// misread those as promotable facts. When there is no <facts> block we fall
	// back to scanning the full text for backward-compat with outputs that emit
	// bare category blocks (older/transition shapes) — but only outside the
	// events block, which we strip first to avoid the cross-read.
	const factsBlockMatch = text.match(FACTS_BLOCK_REGEX);
	// When a <facts> block is present (the v2 norm), scope extraction to it.
	// The fallback (legacy/transition outputs with bare category blocks) strips
	// BOTH the events block AND every <compartment> body first — otherwise a
	// category-shaped tag living inside a compartment's P1-P4 prose (or its
	// attributes) would be misread as a promotable fact.
	const factsBlockContent = factsBlockMatch ? capture(factsBlockMatch, 1) : undefined;
	const legacyFactsScope = text
		.replace(EVENTS_BLOCK_REGEX, "")
		.replace(/<compartment\s+[^>]*?\s*>.*?<\/compartment>/gs, "");
	const factsScope = factsBlockContent ?? legacyFactsScope;
	for (const categoryMatch of factsScope.matchAll(CATEGORY_BLOCK_REGEX)) {
		const category = capture(categoryMatch, 1);
		const blockContent = capture(categoryMatch, 2);
		if (category === undefined || blockContent === undefined) continue;
		for (const itemMatch of blockContent.matchAll(FACT_ITEM_REGEX)) {
			const item = capture(itemMatch, 1);
			if (item === undefined) continue;
			const content = unescapeXml(item.trim());
			if (content) {
				facts.push({ category, content });
			}
		}
	}

	const unprocessedMatch = text.match(UNPROCESSED_REGEX);
	const unprocessedRaw = unprocessedMatch ? capture(unprocessedMatch, 1) : undefined;
	const unprocessedFrom = unprocessedRaw === undefined ? null : parseInt(unprocessedRaw, 10);

	const userObservations: string[] = [];
	const userObsMatch = text.match(USER_OBSERVATIONS_REGEX);
	if (userObsMatch) {
		const block = capture(userObsMatch, 1);
		if (block !== undefined) {
			for (const itemMatch of block.matchAll(USER_OBS_ITEM_REGEX)) {
				const item = capture(itemMatch, 1);
				if (item === undefined) continue;
				const obs = unescapeXml(item.trim());
				if (obs) userObservations.push(obs);
			}
		}
	}

	const primerCandidates: ParsedPrimerCandidate[] = [];
	const primerMatch = text.match(PRIMER_CANDIDATES_REGEX);
	if (primerMatch) {
		const block = capture(primerMatch, 1);
		if (block !== undefined) {
			// Preferred: <primer at_compartment="N">…</primer> with origin ordinal.
			let sawElement = false;
			for (const el of block.matchAll(PRIMER_ELEMENT_REGEX)) {
				const originRaw = capture(el, 1);
				const questionRaw = capture(el, 2);
				if (originRaw === undefined || questionRaw === undefined) continue;
				sawElement = true;
				const question = unescapeXml(questionRaw.trim());
				if (question) {
					primerCandidates.push({
						question,
						originCompartmentIndex: Number.parseInt(originRaw, 10),
					});
				}
			}
			// Legacy bullet form (no origin tag) — only if no element form was used,
			// so an element-form question isn't also captured as a bullet line.
			if (!sawElement) {
				for (const itemMatch of block.matchAll(PRIMER_ITEM_REGEX)) {
					const item = capture(itemMatch, 1);
					if (item === undefined) continue;
					const question = unescapeXml(item.trim());
					if (question) primerCandidates.push({ question });
				}
			}
		}
	}

	const events = parseEvents(text);

	compartments.sort((a, b) => a.startMessage - b.startMessage);

	return { compartments, facts, events, unprocessedFrom, userObservations, primerCandidates };
}

/**
 * Parse the optional <events> block. Each direct child element with an
 * `at_compartment` attribute is an event; its own child elements become
 * `fields`. Kind-agnostic so new event kinds/fields need no parser change.
 * Returns [] when there is no <events> block (the common case).
 */
function parseEvents(text: string): ParsedEvent[] {
	const blockMatch = text.match(EVENTS_BLOCK_REGEX);
	if (!blockMatch) return [];
	const block = capture(blockMatch, 1);
	if (block === undefined) return [];
	const events: ParsedEvent[] = [];
	for (const elMatch of block.matchAll(EVENT_ELEMENT_REGEX)) {
		const kind = capture(elMatch, 1);
		const atCompartmentRaw = capture(elMatch, 2);
		const fieldsBlock = capture(elMatch, 3);
		if (kind === undefined || atCompartmentRaw === undefined || fieldsBlock === undefined) continue;
		const atRaw = parseInt(atCompartmentRaw, 10);
		const atCompartment = Number.isNaN(atRaw) ? null : atRaw;
		const fields: Record<string, string> = {};
		for (const fieldMatch of fieldsBlock.matchAll(EVENT_FIELD_REGEX)) {
			const name = capture(fieldMatch, 1);
			const fieldValue = capture(fieldMatch, 2);
			if (name === undefined || fieldValue === undefined) continue;
			const value = unescapeXml(fieldValue.trim());
			if (value) fields[name] = value;
		}
		events.push({ kind, atCompartment, fields });
	}
	return events;
}

function unescapeXml(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}
