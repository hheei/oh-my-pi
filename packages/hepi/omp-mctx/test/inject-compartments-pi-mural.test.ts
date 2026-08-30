import { describe, expect, it } from "vitest";
import { getOrCreateSessionMeta } from "#core/features/storage";
import { closeQuietly } from "#core/shared/sqlite-helpers";
import { __test, injectM0M1Pi, type PiM0M1State } from "../src/core/hooks/inject-compartments";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

const SESSION_ID = "ses_pi_mural_inject";

// 1x1 transparent PNG data URL (same fixture as OpenCode mural inject tests).
const FAKE_MURAL_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const FAKE_MURAL_BASE64 = FAKE_MURAL_DATA_URL.slice("data:image/png;base64,".length);

function muralOption() {
	return {
		enabled: true,
		supportsVision: true,
		dataUrl: FAKE_MURAL_DATA_URL,
		contentHash: "mural-hash-1",
	};
}

function baseState(overrides: Partial<PiM0M1State> = {}): PiM0M1State {
	return {
		sessionId: SESSION_ID,
		projectIdentity: "git:pi-mural",
		projectDirectory: "/tmp/pi-mural",
		hardSignals: {
			systemHash: "sys",
			modelKey: "anthropic/claude-sonnet-4",
			cacheExpired: false,
			lastResponseTime: 0,
		},
		...overrides,
	};
}

function replaceCurrentManifest(db: ReturnType<typeof createTestDb>): string {
	const image = Buffer.from("current pi mural", "utf8");
	db.prepare(
		`INSERT OR REPLACE INTO mural_manifest
			(project_path, image, content_hash, rendered_at, memory_ids_json, width, height)
		 VALUES (?, ?, ?, ?, '[]', 1, 1)`,
	).run("git:pi-mural", image, "current-pi-manifest", Date.now());
	return image.toString("base64");
}

function findM0Image(messages: unknown[]): {
	type?: string;
	mimeType?: string;
	data?: string;
} | null {
	const head = messages[0] as { content?: unknown } | undefined;
	if (!head || !Array.isArray(head.content)) return null;
	for (const part of head.content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "image") {
			return part as { type?: string; mimeType?: string; data?: string };
		}
	}
	return null;
}

describe("Pi m[0] mural image fold (on-demand render → wire)", () => {
	it("folds the <memory-mural> block and Pi image part on HARD, replays byte-identical on defer", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const state = baseState({ mural: muralOption() });

			const hardMessages = [userMessage("hello")];
			const first = injectM0M1Pi(state, db, hardMessages as never, undefined, true);
			expect(first.injected).toBe(true);
			expect(first.m0Materialized).toBe(true);
			expect(textOf(hardMessages[0])).toContain("<memory-mural>");
			const hardImage = findM0Image(hardMessages);
			expect(hardImage).toBeDefined();
			expect(hardImage?.mimeType).toBe("image/png");
			expect(hardImage?.data).toBe(FAKE_MURAL_BASE64);

			// Simulate restart after another session advances the project manifest.
			// The defer must reload this session's persisted frozen payload instead.
			const currentManifestBase64 = replaceCurrentManifest(db);
			__test.clearPiMuralProcessCache(SESSION_ID);
			const deferState = baseState();
			const deferMessages = [userMessage("again")];
			const second = injectM0M1Pi(deferState, db, deferMessages as never, undefined, false);
			expect(second.m0Materialized).toBe(false);
			expect(textOf(deferMessages[0])).toContain("<memory-mural>");
			const deferImage = findM0Image(deferMessages);
			expect(deferImage?.data).toBe(FAKE_MURAL_BASE64);
			expect(deferImage?.data).not.toBe(currentManifestBase64);
			expect(textOf(deferMessages[0])).toBe(textOf(hardMessages[0]));
		} finally {
			closeQuietly(db);
		}
	});

	it("hydrates a sibling cached-row mural payload", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({ mural: muralOption() }),
				db,
				[userMessage("hard")] as never,
				undefined,
				true,
			);

			const siblingDataUrl = "data:image/png;base64,cGktc2libGluZy1tdXJhbA==";
			db.prepare(
				`UPDATE session_meta
					SET cached_m0_mural_data_url = ?, cached_m0_mural_hash = ?,
						cached_m0_materialized_at = cached_m0_materialized_at + 1
				  WHERE session_id = ?`,
			).run(siblingDataUrl, "pi-sibling-hash", SESSION_ID);

			const messages = [userMessage("soft")];
			injectM0M1Pi(baseState(), db, messages as never, undefined, true);
			expect(findM0Image(messages)?.data).toBe(
				siblingDataUrl.slice("data:image/png;base64,".length),
			);
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("uses a text-only fallback when a legacy cached row lacks its image payload", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({ mural: muralOption() }),
				db,
				[userMessage("hard")] as never,
				undefined,
				true,
			);
			const currentManifestBase64 = replaceCurrentManifest(db);
			db.prepare(
				`UPDATE session_meta
					SET cached_m0_mural_data_url = NULL, cached_m0_mural_hash = NULL
				  WHERE session_id = ?`,
			).run(SESSION_ID);
			__test.clearPiMuralProcessCache(SESSION_ID);

			const messages = [userMessage("defer")];
			injectM0M1Pi(baseState(), db, messages as never, undefined, false);
			expect(findM0Image(messages)).toBeNull();
			expect(findM0Image(messages)?.data).not.toBe(currentManifestBase64);
			expect(textOf(messages[0])).not.toContain("<memory-mural>");
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("omits the mural when the feature flag is off", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const messages = [userMessage("hello")];
			const result = injectM0M1Pi(
				baseState({ muralEnabled: false }),
				db,
				messages as never,
				undefined,
				true,
			);
			expect(result.injected).toBe(true);
			expect(textOf(messages[0])).not.toContain("<memory-mural>");
			expect(findM0Image(messages)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});
});
