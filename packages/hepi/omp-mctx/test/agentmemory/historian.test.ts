import { describe, expect, it } from "bun:test";
import {
	admitHistorianCandidate,
	contentFingerprint,
	createHistorianBackground,
	formatHistorianBackground,
	normalizeHistorianType,
	mapParserCategory,
	reconcileHistorianProvenance,
} from "../../src/agentmemory/historian.ts";

describe("agentmemory historian bridge", () => {
	it("does not admit recalled or recall-only assistant material", () => {
		const result = admitHistorianCandidate({
			content: "Use the durable memory service.",
			evidence: [
				{
					kind: "retrieval",
					content: "Use the durable memory service.",
					hostEntryId: "r1",
					derivedFromRetrieval: true,
				},
				{ kind: "assistant", content: "Use the durable memory service.", hostEntryId: "a1", tainted: true },
			],
		});
		expect(result).toEqual({ accepted: false, reason: "tainted" });
	});

	it("admits independently evidenced facts with native taxonomy and stable source references", () => {
		const content = "The service is scoped by project.";
		const result = admitHistorianCandidate({
			content,
			type: "architecture",
			evidence: [{ kind: "user", content, hostEntryId: "entry-7", harnessId: "omp" }],
		});
		expect(result).toEqual({
			accepted: true,
			candidate: {
				content,
				type: "architecture",
				sourceRefs: [{ hostEntryId: "entry-7", harnessId: "omp", contentFingerprint: contentFingerprint(content) }],
			},
		});
	});

	it("keeps distinct folded tool identities and rejects ambiguous host-only mappings", () => {
		const first = { kind: "tool" as const, content: "edited config", hostEntryId: "fold-1", toolCallId: "call-a" };
		const second = { kind: "tool" as const, content: "edited config", hostEntryId: "fold-1", toolCallId: "call-b" };
		const kept = reconcileHistorianProvenance([first, second]);
		expect(kept.ok).toBe(true);
		if (kept.ok) expect(kept.sources.map(source => source.toolCallId)).toEqual(["call-a", "call-b"]);
		expect(reconcileHistorianProvenance([{ kind: "tool", content: "edited config", hostEntryId: "fold-1" }])).toEqual(
			{
				ok: true,
				sources: [{ hostEntryId: "fold-1", contentFingerprint: contentFingerprint("edited config") }],
			},
		);
		expect(
			reconcileHistorianProvenance([
				{ kind: "user", content: "same", hostEntryId: "fold-1" },
				{ kind: "user", content: "same again", hostEntryId: "fold-1" },
			]),
		).toEqual({ ok: false, reason: "ambiguous-provenance" });
	});

	it("fails closed for stale fingerprints and scopes background recall", () => {
		const stale = reconcileHistorianProvenance([
			{ kind: "user", content: "new", hostEntryId: "entry-1", contentFingerprint: contentFingerprint("old") },
		]);
		expect(stale).toEqual({ ok: false, reason: "stale-provenance" });
		const background = createHistorianBackground(
			[
				{ content: "in scope", project: "repo", agentId: "a" },
				{ content: "wrong project", project: "other", agentId: "a" },
				{ content: "wrong agent", project: "repo", agentId: "b" },
			],
			{ project: "repo", agentId: "a" },
		);
		expect(formatHistorianBackground(background)).toContain("not evidence");
		expect(background.recall.map(item => item.content)).toEqual(["in scope"]);
	});

	it("accepts only backend-native taxonomy", () => {
		expect(normalizeHistorianType("preference")).toBe("preference");
		expect(normalizeHistorianType("workflow")).toBe("workflow");
		expect(normalizeHistorianType("unknown-backend-type")).toBeUndefined();
	});

	it("maps the production parser taxonomy explicitly", () => {
		expect(mapParserCategory("PROJECT_RULES")).toBe("workflow");
		expect(mapParserCategory("ARCHITECTURE")).toBe("architecture");
		expect(mapParserCategory("CONFIG_VALUES")).toBe("fact");
		expect(mapParserCategory("NAMING")).toBe("preference");
	});
});
