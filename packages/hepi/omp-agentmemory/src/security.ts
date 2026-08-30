const LOOPBACK_HOSTS: Record<string, true> = {
	localhost: true,
	"127.0.0.1": true,
	"::1": true,
};

export function usesPlaintextBearerAuth(baseUrl: string, secret?: string): boolean {
	if (!secret) return false;
	try {
		const parsed = new URL(baseUrl);
		const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		return parsed.protocol === "http:" && !LOOPBACK_HOSTS[hostname];
	} catch {
		return false;
	}
}

export function plaintextBearerAuthMessage(baseUrl: string): string {
	return `omp-agentmemory: AGENTMEMORY_SECRET is configured for plaintext HTTP to ${baseUrl}. Use HTTPS, loopback, or an SSH tunnel.`;
}

export function createPlaintextBearerAuthGuard(
	warn: (message: string) => void = (message) => console.warn(message),
	env?: { AGENTMEMORY_REQUIRE_HTTPS?: string },
): (baseUrl: string, secret?: string) => void {
	let warned = false;
	return (baseUrl, secret) => {
		if (!usesPlaintextBearerAuth(baseUrl, secret)) return;
		const message = plaintextBearerAuthMessage(baseUrl);
		if ((env || process.env).AGENTMEMORY_REQUIRE_HTTPS === "1") throw new Error(message);
		if (!warned) {
			warned = true;
			warn(message);
		}
	};
}
