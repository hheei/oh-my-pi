import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__resetLocalEmbeddingForTests,
	__setLocalEmbeddingTestHooks,
	isNativeRuntimeMissingError,
	LocalEmbeddingProvider,
} from "./embedding-local.ts";

afterEach(() => {
	__resetLocalEmbeddingForTests();
	delete process.env.NODE_ENV;
	delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
});

function nativeBindingLoadError(): Error & { code: string } {
	return Object.assign(
		new Error("ERR_DLOPEN_FAILED: onnxruntime-node/onnxruntime_binding.node failed to load"),
		{ code: "ERR_DLOPEN_FAILED" },
	);
}

function fakeTransformersModule(onPipeline?: (options: { dtype: string; device?: string }) => void) {
	return {
		env: {},
		LogLevel: { ERROR: "error" },
		pipeline: async (_task: string, _model: string, options: { dtype: string; device?: string }) => {
			onPipeline?.(options);
			return async () => ({ data: new Float32Array([0, 1]), dims: [1, 2] });
		},
	};
}

describe("isNativeRuntimeMissingError", () => {
	test("ERR_DLOPEN_FAILED on onnxruntime binding is missing-runtime", () => {
		expect(isNativeRuntimeMissingError(nativeBindingLoadError())).toBe(true);
	});
});

describe("native-to-WASM fallback", () => {
	test("retries classified native failure via transformers.web.js seam", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "omp-mctx-wasm-"));
		process.env.NODE_ENV = "test";
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = cacheDir;
		let nativeImports = 0;
		let wasmImports = 0;
		let wasmInjections = 0;
		const pipelineOptions: Array<{ dtype: string; device?: string }> = [];
		try {
			__setLocalEmbeddingTestHooks({
				importTransformers: async () => {
					nativeImports++;
					throw nativeBindingLoadError();
				},
				injectWasmOrt: async (force) => {
					if (!force) return false;
					wasmInjections++;
					return true;
				},
				importTransformersWasmFallback: async () => {
					wasmImports++;
					return fakeTransformersModule((options) => pipelineOptions.push(options));
				},
			});
			expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
			expect(nativeImports).toBe(1);
			expect(wasmImports).toBe(1);
			expect(wasmInjections).toBe(1);
			expect(pipelineOptions).toEqual([{ dtype: "fp32", device: "auto" }]);

			expect(await new LocalEmbeddingProvider().initialize()).toBe(true);
			expect(nativeImports).toBe(1);
			expect(wasmImports).toBe(2);
			expect(wasmInjections).toBe(2);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});
});
