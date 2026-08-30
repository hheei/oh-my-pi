import { RAW_LATEST_SCHEMA_SQL } from "./latest-schema";

const FTS_SHADOW_TABLE_DDL =
	/CREATE TABLE IF NOT EXISTS ['"](?:primers|memories|message_history|git_commits)_fts_(?:data|idx|docsize|config|content)['"][\s\S]*?;\n/g;

/** Tables owned only by the legacy durable-memory feature and its module mirror. */
export const DURABLE_MEMORY_TABLES = [
	"authority_capture_bounds",
	"authority_managed",
	"authority_repair_pending",
	"context_store_meta",
	"embedding_identity_active",
	"embedding_measurement_corpus",
	"embedding_registrations",
	"compartment_chunk_embeddings",
	"git_commit_embeddings",
	"git_commits",
	"git_sweep_coordinator",
	"memories",
	"memory_embeddings",
	"memory_mutation_log",
	"memory_verifications",
	"mirror_cursors",
	"mirror_identity",
	"mirror_live_memory_rows",
	"mirror_live_staging",
	"mirror_note_revisions",
	"mirror_pending_references",
	"mirror_resnapshot_state",
	"primer_candidates",
	"primers",
	"shadow_embedding_registrations",
	"user_memories",
	"user_memory_candidates",
] as const;

const DURABLE_MEMORY_DDL = new RegExp(
	`\\b(?:${DURABLE_MEMORY_TABLES.join("|")})(?:\\b|_[a-z]+)`, 
	"i",
);

function stripFtsShadowTables(schema: string): string {
	return schema.replace(FTS_SHADOW_TABLE_DDL, "");
}

function stripDurableMemoryDdl(schema: string): string {
	return schema
		.split(/(?<=;\n)/)
		.filter((statement) => !DURABLE_MEMORY_DDL.test(statement))
		.join("");
}

export const LATEST_SCHEMA_SQL = stripFtsShadowTables(RAW_LATEST_SCHEMA_SQL);

/** Fresh schema for Window-only OMP installs with legacy Durable Memory disabled. */
export const WINDOW_SCHEMA_SQL = stripDurableMemoryDdl(LATEST_SCHEMA_SQL);
