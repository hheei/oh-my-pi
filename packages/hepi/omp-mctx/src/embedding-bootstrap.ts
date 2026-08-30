import { resolveProjectIdentityForSession } from "#core/features/memory/project-identity";
import {
	type EmbeddingFeatures,
	registerProjectEmbedding,
} from "#core/features/project-embedding-registry";
import type { ContextDatabase } from "#core/features/storage";
import { loadPiConfig } from "./config";

const registeredProjectsByDatabase = new WeakMap<object, Set<string>>();

/** Registers one project embedding snapshot for the current Pi MCTX config boot. */
export async function ensureProjectRegisteredFromPiDirectory(
	directory: string,
	db: ContextDatabase,
): Promise<void> {
	const config = loadPiConfig();
	if (!config.memory.enabled) return;
	const projectIdentity = resolveProjectIdentityForSession(directory, config.allow_home_project);
	if (!projectIdentity) return;

	let registeredProjects = registeredProjectsByDatabase.get(db);
	if (!registeredProjects) {
		registeredProjects = new Set();
		registeredProjectsByDatabase.set(db, registeredProjects);
	}
	if (registeredProjects.has(projectIdentity)) return;

	const features: EmbeddingFeatures = {
		memoryEnabled: config.memory.enabled,
		gitCommitEnabled: config.memory.git_commit_indexing.enabled,
	};
	registerProjectEmbedding(db, projectIdentity, config.embedding, features, directory);
	registeredProjects.add(projectIdentity);
}
