/**
 * Stable structural boundary for Pi's session client.
 *
 * Pi SDK request and response shapes evolve independently from Magic Context.
 * Feature modules pass each response through `normalizeSDKResponse`, so they
 * only need to know which session operations are available. The bivariant
 * parameter keeps concrete SDK methods with narrower request types assignable
 * while preserving `unknown` at this boundary.
 */
type SessionOperation = {
	bivarianceHack(input: unknown): Promise<unknown>;
}["bivarianceHack"];

export interface PluginContext {
	client: {
		session: {
			create: SessionOperation;
			delete: SessionOperation;
			get: SessionOperation;
			list: SessionOperation;
			messages: SessionOperation;
			prompt: SessionOperation;
		};
	};
}
