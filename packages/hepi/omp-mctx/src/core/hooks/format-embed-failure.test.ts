import { describe, expect, test } from "bun:test";
import type { EmbeddingFailure } from "../features/memory/embedding-failure";
import { formatEmbedFailureSummary } from "./format-embed-failure.ts";

const failures: EmbeddingFailure[] = [
	{
		class: "substitution_rejected",
		reason:
			"served model 'bge-m3' does not match requested 'baai/bge-m3-embedding' (substitution guard)",
		retryable: false,
	},
	{
		class: "http_error",
		reason: "HTTP 402 from endpoint: quota exhausted",
		retryable: false,
	},
	{
		class: "empty_result",
		reason: "response data[] was empty",
		retryable: true,
	},
	{
		class: "invalid_envelope",
		reason: "response had keys [object, results] but data[] was absent",
		retryable: false,
	},
	{
		class: "invalid_envelope",
		reason:
			"response had keys [data, object] but data[].embedding was absent for some inputs",
		retryable: true,
	},
];

describe("formatEmbedFailureSummary", () => {
	test.each(failures)("surfaces $class retryable=$retryable", (failure) => {
		const summary = formatEmbedFailureSummary(0, 193, failure);
		expect(summary).toContain(failure.reason);
		if (failure.retryable) {
			expect(summary).toContain("Run /ctx-embed start again to retry them.");
		} else {
			expect(summary).not.toContain("Run /ctx-embed start again to retry them.");
		}
	});
});
