import { chmodSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getMagicContextStorageDir } from "../shared/data-path";
import { getErrorMessage } from "../shared/error-message";
import { log } from "../shared/logger";
import { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import { shouldEnforcePrivateStoragePermissions } from "../shared/storage-permissions";
import { ensureContextStoreUuid } from "./context-authority";
import { LATEST_SCHEMA_SQL, WINDOW_SCHEMA_SQL } from "./fresh-schema";
import {
	loadToolDefinitionMeasurements,
	setDatabase as setToolDefinitionDatabase,
} from "./tool-definition-tokens";
import { createDbLkgPersistence, LKG_SLOTS_DDL } from "../hooks/lkg-persist";
import { registerLkgPersistence } from "../hooks/lkg-slot";

const databases = new Map<string, Database>();
const pendingAsyncOpens = new Map<string, Promise<Database>>();
const persistenceByDatabase = new WeakMap<Database, boolean>();
const pathByDatabase = new WeakMap<Database, string>();

// chmod is meaningless on Windows (POSIX modes are not honored), so all
// permission tightening is skipped there. mkdir's `mode` is likewise ignored.
const PERMISSIONS_ENFORCEABLE = process.platform !== "win32";

const defaultStoragePermissionFs = { chmodSync, mkdirSync };
let storagePermissionFs = defaultStoragePermissionFs;

/** Test seam: captures permission-changing calls without changing real fixture modes. */
export function __setStoragePermissionFsForTests(
	overrides: Partial<typeof defaultStoragePermissionFs>,
): void {
	storagePermissionFs = { ...defaultStoragePermissionFs, ...overrides };
}

export function __resetStoragePermissionFsForTests(): void {
	storagePermissionFs = defaultStoragePermissionFs;
}

/**
 * Create `dir` recursively. When private permissions are enabled, also create
 * and tighten it to owner-only 0o700. When an operator manages trusted-group
 * permissions, do not pass a mode or chmod an existing directory.
 */
function ensureSecureStorageDir(dir: string): void {
	if (!shouldEnforcePrivateStoragePermissions()) {
		storagePermissionFs.mkdirSync(dir, { recursive: true });
		return;
	}

	storagePermissionFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!PERMISSIONS_ENFORCEABLE) return;
	try {
		storagePermissionFs.chmodSync(dir, 0o700);
	} catch (error) {
		log(
			`[magic-context] could not restrict storage dir permissions on ${dir}: ${getErrorMessage(error)}`,
		);
	}
}

/**
 * Restrict the SQLite DB file and its WAL/SHM sidecars to owner-only (0o600)
 * only when Magic Context owns storage permission management. A trusted-group
 * deployment keeps the operator's modes unchanged, including sidecars.
 */
function restrictDatabaseFilePermissions(dbPath: string): void {
	if (!PERMISSIONS_ENFORCEABLE || !shouldEnforcePrivateStoragePermissions()) return;
	for (const suffix of ["", "-wal", "-shm"]) {
		const file = `${dbPath}${suffix}`;
		if (!existsSync(file)) continue;
		try {
			storagePermissionFs.chmodSync(file, 0o600);
		} catch (error) {
			log(
				`[magic-context] could not restrict DB file permissions on ${file}: ${getErrorMessage(error)}`,
			);
		}
	}
}

export interface OpenDatabaseOptions {
	dbPath?: string | undefined;
	/** Defaults false: legacy Durable Memory is explicitly opted in by the runtime. */
	memoryEnabled?: boolean | undefined;
}

// Exported for the test-isolation guard test. Returns a PATH only — opens no DB —
// so a regression assertion is safe even if the resolution is wrong.
export function resolveDatabasePath(dbPathOverride?: string): { dbDir: string; dbPath: string } {
	if (dbPathOverride) {
		return { dbDir: dirname(dbPathOverride), dbPath: dbPathOverride };
	}
	// Test isolation: preload provides a root, while individual cases may
	// replace or clear XDG_DATA_HOME. Production never reads this variable.
	const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
	if (testDataDir && !process.env.XDG_DATA_HOME) {
		const dbDir = join(testDataDir, "extensions", "omp-mctx");
		return { dbDir, dbPath: join(dbDir, "context.db") };
	}
	// A test started outside the configured preload must never use Pi storage.
	// Bun sets NODE_ENV=test under every test invocation. With no preload,
	// redirect into a private temporary root before opening SQLite.
	if (process.env.NODE_ENV === "test" && !process.env.XDG_DATA_HOME) {
		// Memoized per-process so repeated openDatabase() calls in the same
		// unisolated test resolve to the SAME path (openDatabase caches by path;
		// a fresh temp dir per call would defeat the cache and hand back
		// different DB handles).
		const dbDir = getTestBackstopDbDir();
		if (!testBackstopWarned) {
			testBackstopWarned = true;
			log(
				"[magic-context] TEST BACKSTOP: NODE_ENV=test with no MAGIC_CONTEXT_TEST_DATA_DIR " +
					`— redirecting DB to a throwaway temp dir (${dbDir}) so no test can touch the ` +
					"user's real shared database. Wire `[test] preload` in this package's bunfig.toml.",
			);
		}
		return { dbDir, dbPath: join(dbDir, "context.db") };
	}
	const dbDir = getMagicContextStorageDir();
	return { dbDir, dbPath: join(dbDir, "context.db") };
}

let testBackstopDbDir: string | null = null;
let testBackstopWarned = false;
function getTestBackstopDbDir(): string {
	if (!testBackstopDbDir) {
		testBackstopDbDir = join(
			mkdtempSync(join(tmpdir(), "mc-test-db-backstop-")),
			"extensions",
			"omp-mctx",
		);
	}
	return testBackstopDbDir;
}

export function getDatabasePath(db: Database): string | null {
	return pathByDatabase.get(db) ?? null;
}

// Per-connection SQLite tuning, settable once at plugin init (before the first
// openDatabase) so the 27 openDatabase call sites don't each need config
// threading. Defaults match the config schema (64 MiB cache, mmap disabled) so
// tests and early-init opens still get sane values.
let sqlitePragmaConfig: { cacheSizeMb: number; mmapSizeMb: number } = {
	cacheSizeMb: 64,
	mmapSizeMb: 0,
};

export function setSqlitePragmaConfig(config: { cacheSizeMb: number; mmapSizeMb: number }): void {
	sqlitePragmaConfig = config;
}

/**
 * Apply the tunable per-connection PRAGMAs (cache_size, mmap_size,
 * analysis_limit) from the current `sqlitePragmaConfig`. Idempotent and safe on
 * an already-open connection — cache_size/mmap_size take effect immediately —
 * so harnesses that open the DB before loading config (Pi) can call this once
 * config is available without reopening.
 */
export function applySqliteTuningPragmas(db: Database): void {
	// cache_size negative value = KiB of page cache (e.g. -65536 = 64 MiB).
	db.exec(`PRAGMA cache_size=-${Math.round(sqlitePragmaConfig.cacheSizeMb * 1024)}`);
	db.exec(`PRAGMA mmap_size=${Math.round(sqlitePragmaConfig.mmapSizeMb * 1024 * 1024)}`);
	// Bound any ANALYZE that a later PRAGMA optimize triggers on this connection.
	db.exec("PRAGMA analysis_limit=400");
}

/**
 * Run SQLite's self-gating planner-stats refresh. `analysis_limit=400` caps the
 * rows sampled per index so even a huge table can't cause a multi-second
 * ANALYZE; `optimize` then re-analyzes only tables whose row counts drifted
 * since the last ANALYZE (a no-op otherwise). Cheap to call periodically.
 */
export function runSqliteOptimize(db: Database): void {
	try {
		db.exec("PRAGMA analysis_limit=400");
		db.exec("PRAGMA optimize");
	} catch {
		// Best-effort maintenance; never fail a caller over stats refresh.
	}
}

const CHANNEL2_CLAIM_TTL_MS = 120_000;

/** Requeue crash-stranded Channel-2 deliveries after their lease expires. */
function healWedgedChannel2Claims(db: Database): void {
	const staleBefore = Date.now() - CHANNEL2_CLAIM_TTL_MS;
	db.prepare(
		"UPDATE session_meta SET channel2_nudge_state = 'pending', channel2_nudge_claimed_at = 0, channel2_nudge_claim_token = '' WHERE channel2_nudge_state = 'claimed' AND (channel2_nudge_claimed_at IS NULL OR channel2_nudge_claimed_at = 0 OR channel2_nudge_claimed_at <= ?)",
	).run(staleBefore);
}


function finishDatabaseOpen(db: Database, dbPath: string): Database {
	// Recover any Channel-2 ceiling-nudge lease left at `claimed` by a crash
	// mid-delivery (see healWedgedChannel2Claims). Fresh opens and later
	// cached-handle reuses both run this TTL-scoped heal so long-lived
	// processes eventually unwind stuck stale claims without a restart.
	healWedgedChannel2Claims(db);
	// Wire the persistence-backed tool-definition measurement store and
	// rehydrate the in-memory map from any prior writes. Doing this here
	// (after migrations) means migration v9 has already created the
	// `tool_definition_measurements` table, so loadToolDefinitionMeasurements
	// never hits a missing-table failure path.
	setToolDefinitionDatabase(db);
	loadToolDefinitionMeasurements(db);
	registerLkgPersistence(createDbLkgPersistence(db));
	// When enabled, tighten the DB + WAL/SHM sidecars now that WAL mode has
	// created them. Externally managed trusted-group storage skips this entirely.
	restrictDatabaseFilePermissions(dbPath);
	databases.set(dbPath, db);
	pathByDatabase.set(db, dbPath);
	persistenceByDatabase.set(db, true);
	return db;
}

export function initializeDatabase(db: Database, options: { memoryEnabled?: boolean } = {}): void {
	const memoryEnabled = options.memoryEnabled ?? false;
	const legacySchema = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
		.get();
	if (legacySchema) {
		throw new Error(
			"legacy Magic Context database detected; remove context.db before starting Pi MCTX",
		);
	}
	db.exec("PRAGMA busy_timeout=5000");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA journal_mode=WAL");
	applySqliteTuningPragmas(db);
	const initialized = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_meta'")
		.get();
	if (!initialized) {
		db.exec(memoryEnabled ? LATEST_SCHEMA_SQL : WINDOW_SCHEMA_SQL);
	} else if (memoryEnabled) {
		// A prior Window-only boot intentionally created no legacy Memory
		// tables. An explicit Memory-on boot upgrades that existing store here;
		// this is idempotent and only runs during database initialization.
		db.exec(LATEST_SCHEMA_SQL);
	}
	if (memoryEnabled) {
		db.prepare(
			"INSERT OR IGNORE INTO mirror_resnapshot_state(domain, status, updated_at, generation) VALUES ('memories', 'pending_check', 0, NULL)",
		).run();
	}
	db.exec(LKG_SLOTS_DDL);
}

/**
 * Open the persistent Magic Context SQLite database.
 *
 * Fails closed: if the database cannot be opened (binary ABI mismatch,
 * unwritable path, corrupted file, etc.), this throws. Magic Context CANNOT
 * silently fall back to an in-memory database, because:
 *   1. An in-memory DB has no project memories, no historian state, no
 *      tag persistence — features that depend on durable storage become
 *      silently broken instead of explicitly disabled.
 *   2. More importantly, an in-memory DB across process restarts effectively
 *      means "no Magic Context", but the plugin still tags messages and
 *      tries to drive transforms. On Pi this can let the full raw history reach
 *      the model and overflow the context window.
 *
 * Any open error fails closed: callers disable Magic Context for that run.
 * There is never an in-memory fallback.
 */
export function openDatabase(): Database;
export function openDatabase(dbPath: string): Database;
export function openDatabase(options: OpenDatabaseOptions): Database;
export function openDatabase(dbPathOrOptions?: string | OpenDatabaseOptions): Database {
	const options =
		typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : dbPathOrOptions;
	const { dbDir, dbPath } = resolveDatabasePath(options?.dbPath);
	const existing = databases.get(dbPath);
	if (existing) {
		if (!persistenceByDatabase.has(existing)) {
			persistenceByDatabase.set(existing, true);
		}
		// processes keep this handle for hours, and a revert/confirm DB lock can
		// leave a stale `claimed` lease behind until some later openDatabase()
		// call. The heal is one idempotent UPDATE gated by claimed_at age.
		healWedgedChannel2Claims(existing);
		return existing;
	}

	let db: Database | undefined;
	try {
		ensureSecureStorageDir(dbDir);

		db = new Database(dbPath);
		initializeDatabase(db, { memoryEnabled: options?.memoryEnabled });
		if (options?.memoryEnabled === true) ensureContextStoreUuid(db);
		return finishDatabaseOpen(db, dbPath);
	} catch (error) {
		if (db) closeQuietly(db);
		const detail = getErrorMessage(error);
		log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
		// No silent in-memory fallback — see comment above. Caller must
		// catch and disable Magic Context for that run.
		throw new Error(
			`[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
		);
	}
}

/**
 * Async boot variant of openDatabase. SQLite calls remain synchronous; this
 * wrapper coalesces concurrent opens for the same database path.
 */
export async function openDatabaseAsync(
	dbPathOrOptions?: string | OpenDatabaseOptions,
): Promise<Database> {
	const options =
		typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : dbPathOrOptions;
	const { dbDir, dbPath } = resolveDatabasePath(options?.dbPath);
	const existing = databases.get(dbPath);
	if (existing) {
		healWedgedChannel2Claims(existing);
		return existing;
	}

	const pending = pendingAsyncOpens.get(dbPath);
	if (pending) return pending;

	const opening = (async (): Promise<Database> => {
		let db: Database | undefined;
		try {
			ensureSecureStorageDir(dbDir);

			db = new Database(dbPath);
			initializeDatabase(db, { memoryEnabled: options?.memoryEnabled });
			if (options?.memoryEnabled === true) ensureContextStoreUuid(db);
			return finishDatabaseOpen(db, dbPath);
		} catch (error) {
			if (db) closeQuietly(db);
			const detail = getErrorMessage(error);
			log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
			throw new Error(
				`[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`,
			);
		}
	})();
	pendingAsyncOpens.set(dbPath, opening);
	try {
		return await opening;
	} finally {
		if (pendingAsyncOpens.get(dbPath) === opening) pendingAsyncOpens.delete(dbPath);
	}
}

export function isDatabasePersisted(db: Database | null): boolean {
	if (!db) return false;
	return persistenceByDatabase.get(db) ?? false;
}

export function closeDatabase(): void {
	pendingAsyncOpens.clear();
	for (const [key, db] of databases) {
		try {
			closeQuietly(db);
		} catch (error) {
			log("[magic-context] storage error:", error);
		} finally {
			databases.delete(key);
		}
	}
}

export type ContextDatabase = Database;
