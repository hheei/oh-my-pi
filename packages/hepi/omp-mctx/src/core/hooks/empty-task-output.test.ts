import { describe, expect, test } from "bun:test";
import {
	annotateEmptyTaskOutputContent,
	EMPTY_TASK_OUTPUT_SENTINEL,
} from "./empty-task-output.ts";

const xml = `<task id="1" state="completed"><task_result></task_result></task>`;


describe("annotateEmptyTaskOutputContent", () => {
	test("returns new content and leaves the original array alone", () => {
		const content = [{ type: "text", text: xml }];
		const next = annotateEmptyTaskOutputContent("task", content);
		expect(next).not.toBe(content);
		expect(next?.[0]?.text).toContain(EMPTY_TASK_OUTPUT_SENTINEL);
		expect(content[0]?.text).toBe(xml);
	});

	test("does not invent a sentinel for empty OMP task text without the envelope", () => {
		const content = [{ type: "text", text: "  " }];
		expect(annotateEmptyTaskOutputContent("task", content)).toBeUndefined();
		expect(content).toEqual([{ type: "text", text: "  " }]);
	});

	test("does not touch bash content", () => {
		const content = [{ type: "text", text: xml }];
		expect(annotateEmptyTaskOutputContent("bash", content)).toBeUndefined();
		expect(content[0]?.text).toBe(xml);
	});
});
