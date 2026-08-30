import { createPlaintextBearerAuthGuard } from "./security.ts";
import { normalizeBaseUrl } from "./format.ts";

const guardPlaintextBearerAuth = createPlaintextBearerAuthGuard();

export type AgentmemoryConfig = {
	url: string;
	secret: string;
};

export async function request<T>(
	pathname: string,
	config: AgentmemoryConfig,
	options?: {
		method?: "GET" | "POST";
		body?: unknown;
		timeoutMs?: number;
	},
): Promise<T | null> {
	const baseUrl = normalizeBaseUrl(config.url);
	const method = options?.method || "POST";
	const url = `${baseUrl}/agentmemory/${pathname.replace(/^\/+/, "")}`;
	const headers: Record<string, string> = {};
	guardPlaintextBearerAuth(baseUrl, config.secret || undefined);
	if (options?.body !== undefined) headers["Content-Type"] = "application/json";
	if (config.secret) headers.Authorization = `Bearer ${config.secret}`;
	try {
		const response = await fetch(url, {
			method,
			headers,
			body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}
