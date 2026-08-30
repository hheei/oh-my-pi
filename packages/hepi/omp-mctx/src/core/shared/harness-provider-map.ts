const CANONICAL_TO_PI_PROVIDER: Record<string, string> = {
	openai: "openai-codex",
	google: "google-antigravity",
};

const PI_TO_CANONICAL_PROVIDER: Record<string, string> = {
	"openai-codex": "openai",
	"google-antigravity": "google",
};

function remapProviderPrefix(ref: string, map: Record<string, string>): string {
	const slash = ref.indexOf("/");
	if (slash <= 0) return ref;
	const mapped = map[ref.slice(0, slash)];
	return mapped ? `${mapped}${ref.slice(slash)}` : ref;
}

/** Normalize Pi provider aliases before selecting its preferred runtime form. */
export function piModelRefToCanonical(ref: string): string {
	return remapProviderPrefix(ref, PI_TO_CANONICAL_PROVIDER);
}

/** Select Pi's preferred provider form for a configured model reference. */
export function resolveModelRefForPi(ref: string): string {
	return remapProviderPrefix(piModelRefToCanonical(ref), CANONICAL_TO_PI_PROVIDER);
}
