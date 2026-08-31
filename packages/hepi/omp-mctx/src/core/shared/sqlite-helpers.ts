/**
 * Cross-runtime helpers that smooth over the small bun:sqlite ↔ node:sqlite
 * API differences without leaking either backend into call sites.
 */

import type { Database } from "./sqlite";

/**
 * Close a database, ignoring errors.
 *
 * bun:sqlite supports `db.close(throwOnError = false)`. node:sqlite has only
 * `db.close()` and throws ("database is not open") on an already-closed
 * handle. This helper mirrors the bun "swallow errors" semantics for both
 * runtimes — useful in test teardown and `finally` blocks where the caller
 * doesn't care whether the close succeeded.
 */
export function closeQuietly(db: Database | null | undefined): void {
	if (!db) return;
	// Just attempt close and swallow errors. bun:sqlite has no `open` property,
	// and node:sqlite throws on an already-closed handle — both are handled by
	// the bare try/catch.
	try {
		db.close();
	} catch {
		// intentional: caller wants quiet close
	}
}
const sqliteTablePresenceCache = new WeakMap<Database, Map<string, boolean>>();

export function hasSqliteTable(db: Database, tableName: string): boolean {
	let cache = sqliteTablePresenceCache.get(db);
	if (!cache) {
		cache = new Map();
		sqliteTablePresenceCache.set(db, cache);
	}
	const cached = cache.get(tableName);
	if (cached !== undefined) return cached;
	const row = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get(tableName);
	const present = row !== undefined && row !== null;
	cache.set(tableName, present);
	return present;
}

export function invalidateSqliteTableCache(db: Database): void {
	sqliteTablePresenceCache.delete(db);
}
