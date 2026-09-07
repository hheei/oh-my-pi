import { log } from "#core/shared/logger";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function usesPlaintextBearerAuth(baseUrl: string, secret?: string): boolean {
	if (!secret) return false;
	try {
		const parsed = new URL(baseUrl);
		const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		return parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(hostname);
	} catch {
		return false;
	}
}

export function plaintextBearerAuthMessage(baseUrl: string): string {
	return `omp-mctx agentmemory: bearer secret would cross plaintext HTTP to ${baseUrl}; use HTTPS, loopback, or an SSH tunnel.`;
}

/** Warn once per client/runtime and optionally fail closed for remote HTTP. */
export function createPlaintextBearerAuthGuard(
	options: { requireHttps?: boolean; warn?: (message: string) => void } = {},
): (baseUrl: string, secret?: string) => void {
	let warned = false;
	return (baseUrl, secret) => {
		if (!usesPlaintextBearerAuth(baseUrl, secret)) return;
		const message = plaintextBearerAuthMessage(baseUrl);
		if (options.requireHttps === true) throw new Error(message);
		if (!warned) {
			warned = true;
			(options.warn ?? ((value: string) => log(value)))(message);
		}
	};
}
