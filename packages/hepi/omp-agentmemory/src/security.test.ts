import { describe, expect, test } from "bun:test";
import { createPlaintextBearerAuthGuard, usesPlaintextBearerAuth } from "./security.ts";

describe("usesPlaintextBearerAuth", () => {
	test("loopback http with secret is ok", () => {
		expect(usesPlaintextBearerAuth("http://127.0.0.1:3111", "s")).toBe(false);
		expect(usesPlaintextBearerAuth("http://localhost:3111", "s")).toBe(false);
	});

	test("remote http with secret is plaintext", () => {
		expect(usesPlaintextBearerAuth("http://judy.example:3111", "s")).toBe(true);
	});

	test("no secret is never plaintext bearer", () => {
		expect(usesPlaintextBearerAuth("http://judy.example:3111")).toBe(false);
	});
});

describe("createPlaintextBearerAuthGuard", () => {
	test("throws when REQUIRE_HTTPS=1", () => {
		const guard = createPlaintextBearerAuthGuard(
			() => {},
			{ AGENTMEMORY_REQUIRE_HTTPS: "1" },
		);
		expect(() => guard("http://judy.example:3111", "s")).toThrow(/plaintext HTTP/);
	});
});
