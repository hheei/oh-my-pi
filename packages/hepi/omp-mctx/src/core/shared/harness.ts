export type HarnessId = "pi";

const HARNESS: HarnessId = "pi";

/** Pi owns this package's process and persistence boundary. */
export function setHarness(value: HarnessId): void {
	if (value !== HARNESS) {
		throw new Error(`Magic Context only supports the ${HARNESS} harness`);
	}
}

export function getHarness(): HarnessId {
	return HARNESS;
}

/** Test seam retained for callers that reset process-scoped state. */
export function _resetHarnessForTesting(): void {}
