import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { closeDatabase, initializeDatabase, openDatabase, openDatabaseAsync } from "../../../src/core/features/storage-db";
import { setChannel2NudgeState } from "../../../src/core/features/storage-meta-persisted";
import { Database } from "../../../src/core/shared/sqlite";
import { closeQuietly } from "../../../src/core/shared/sqlite-helpers";

interface ChildResult {
	ok: boolean;
	schema: boolean;
}

function packagePaths(): { packageRoot: string; repoRoot: string; sqlitePath: string; storagePath: string } {
	const packageRoot = path.join(import.meta.dirname, "../../..");
	return {
		packageRoot,
		repoRoot: path.join(packageRoot, "../.."),
		sqlitePath: path.join(packageRoot, "src/core/shared/sqlite.ts"),
		storagePath: path.join(packageRoot, "src/core/features/storage-db.ts"),
	};
}

function collectChildJson(child: childProcess.ChildProcessWithoutNullStreams): Promise<ChildResult> {
	const { promise, resolve, reject } = Promise.withResolvers<ChildResult>();
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", chunk => stdout.push(chunk));
	child.stderr.on("data", chunk => stderr.push(chunk));
	child.on("error", reject);
	child.on("close", code => {
		if (code !== 0) {
			reject(new Error(Buffer.concat(stderr).toString() || `child exited ${code}`));
			return;
		}
		try {
			resolve(JSON.parse(Buffer.concat(stdout).toString()) as ChildResult);
		} catch (error) {
			reject(error);
		}
	});
	return promise;
}

function waitForChildExit(child: childProcess.ChildProcessWithoutNullStreams): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	child.on("error", reject);
	child.on("close", code => {
		if (code === 0) resolve();
		else reject(new Error(`child exited ${code}`));
	});
	return promise;
}
async function stopChild(child: childProcess.ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	child.once("error", reject);
	child.once("close", () => resolve());
	child.kill();
	await promise;
}
function waitForLine(child: childProcess.ChildProcessWithoutNullStreams, expected: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let output = "";
	const onData = (chunk: Buffer): void => {
		output += chunk.toString();
		if (!output.includes(expected)) return;
		child.stdout.off("data", onData);
		resolve();
	};
	child.stdout.on("data", onData);
	child.on("error", reject);
	return promise;
}
function spawnJiti(script: string): childProcess.ChildProcessWithoutNullStreams {
	const { repoRoot } = packagePaths();
	return childProcess.spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: repoRoot,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

describe("persistent database opening under SQLite contention", () => {
	test("retries a locked async open after the first busy timeout", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-storage-open-retry-"));
		const dbPath = path.join(dir, "context.db");
		const setup = new Database(dbPath);
		initializeDatabase(setup);
		closeQuietly(setup);
		const lock = new Database(dbPath);
		lock.exec("PRAGMA busy_timeout=5000");
		lock.exec("BEGIN IMMEDIATE");
		const { packageRoot, sqlitePath, storagePath } = packagePaths();
		const script = `
			import { createJiti } from "jiti";
			const jiti = createJiti(${JSON.stringify(path.join(packageRoot, "package.json"))});
			await jiti.import(${JSON.stringify(sqlitePath)});
			const storage = await jiti.import(${JSON.stringify(storagePath)});
			const db = await storage.openDatabaseAsync(${JSON.stringify(dbPath)});
			console.log(JSON.stringify({ ok: true, schema: db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_meta'").get() !== null }));
			storage.closeDatabase();
		`;
		const child = spawnJiti(script);
		const result = collectChildJson(child);
		try {
			// The first attempt has a real 5s SQLite busy timeout; releasing only
			// after it expires proves the second bounded attempt is effective.
			await Bun.sleep(5_100);
			lock.exec("COMMIT");
			expect(await result).toEqual({ ok: true, schema: true });
		} finally {
			await stopChild(child);
			closeQuietly(lock);
			closeDatabase();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 15_000);

	test("cached opens do not write while another process holds the writer lock", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-storage-cached-heal-"));
		const dbPath = path.join(dir, "context.db");
		const db = openDatabase(dbPath);
		setChannel2NudgeState(db, "stale-claim", "claimed");
		db.prepare(
			"UPDATE session_meta SET channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ?",
		).run(Date.now() - 300_000, "stale-token", "stale-claim");
		const { packageRoot, sqlitePath } = packagePaths();
		const script = `
			import { createJiti } from "jiti";
			const jiti = createJiti(${JSON.stringify(path.join(packageRoot, "package.json"))});
			const sqlite = await jiti.import(${JSON.stringify(sqlitePath)});
			const holder = new sqlite.Database(${JSON.stringify(dbPath)});
			holder.exec("PRAGMA busy_timeout=5000");
			holder.exec("BEGIN IMMEDIATE");
			console.log("READY");
			for await (const _ of process.stdin) break;
			holder.exec("ROLLBACK");
			holder.close();
		`;
		const child = spawnJiti(script);
		try {
			await waitForLine(child, "READY");
			const started = performance.now();
			const sync = openDatabase(dbPath);
			const asyncDb = await openDatabaseAsync(dbPath);
			const elapsed = performance.now() - started;
			expect(sync).toBe(db);
			expect(asyncDb).toBe(db);
			expect(elapsed).toBeLessThan(1_000);
			child.stdin.end("release\n");
			await waitForChildExit(child);
			expect(
				db.prepare("SELECT channel2_nudge_state FROM session_meta WHERE session_id = ?")
					.get("stale-claim"),
			).toEqual({ channel2_nudge_state: "claimed" });
		} finally {
			await stopChild(child);
			closeDatabase();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
