import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	applyRtkRewrite,
	type BashCallEvent,
	buildSudoBlockReason,
	detectSudoSegments,
	parseRtkRewriteOutput,
	probeRtkAvailability,
	type RtkRewriteLookup,
	rewriteChain,
	splitChain,
} from "./rtk.ts";

/** Build a fresh bash tool_call event for hook tests. */
function bashEvent(command: string): BashCallEvent {
	return { toolName: "bash", input: { command } };
}

describe("probeRtkAvailability", () => {
	it("probes rtk directly and accepts a successful version check", async () => {
		const exec = mock(async () => ({
			stdout: "rtk 0.1.0",
			stderr: "",
			code: 0,
			killed: false,
		}));

		expect(
			await probeRtkAvailability({ exec } as Pick<ExtensionAPI, "exec">),
		).toBe(true);
		expect(exec).toHaveBeenCalledWith("rtk", ["--version"], { timeout: 3000 });
	});

	it("rejects an unsuccessful version check", async () => {
		const exec = mock(async () => ({
			stdout: "",
			stderr: "missing",
			code: 1,
			killed: false,
		}));

		expect(
			await probeRtkAvailability({ exec } as Pick<ExtensionAPI, "exec">),
		).toBe(false);
	});

	it("treats a spawn failure as unavailable", async () => {
		const exec = mock(async () => {
			throw new Error("ENOENT");
		});

		expect(
			await probeRtkAvailability({ exec } as Pick<ExtensionAPI, "exec">),
		).toBe(false);
	});
});

describe("splitChain", () => {
	it("returns single segment for plain command", () => {
		expect(splitChain("git status")).toEqual(["git status"]);
	});

	it("splits on && keeping operator", () => {
		expect(splitChain("git add . && git push")).toEqual([
			"git add . ",
			"&&",
			" git push",
		]);
	});

	it("splits on ||, ;, |", () => {
		expect(splitChain("a || b")).toEqual(["a ", "||", " b"]);
		expect(splitChain("a ; b")).toEqual(["a ", ";", " b"]);
		expect(splitChain("a | b")).toEqual(["a ", "|", " b"]);
	});

	it("ignores operators inside double quotes", () => {
		expect(splitChain('git commit -m "a && b"')).toEqual([
			'git commit -m "a && b"',
		]);
	});

	it("ignores operators inside single quotes", () => {
		expect(splitChain("echo 'x | y'")).toEqual(["echo 'x | y'"]);
	});

	it("returns null on unbalanced quotes", () => {
		expect(splitChain('git commit -m "oops')).toBeNull();
	});
});

describe("parseRtkRewriteOutput", () => {
	it("accepts rtk rewrite success codes", () => {
		expect(parseRtkRewriteOutput(0, "rtk git status", "git status")).toBe(
			"rtk git status",
		);
		expect(parseRtkRewriteOutput(3, "rtk git status", "git status")).toBe(
			"rtk git status",
		);
	});

	it("rejects no-match, deny, and empty or identical stdout", () => {
		expect(
			parseRtkRewriteOutput(1, "rtk git status", "git status"),
		).toBeUndefined();
		expect(
			parseRtkRewriteOutput(2, "rtk git status", "git status"),
		).toBeUndefined();
		expect(parseRtkRewriteOutput(0, "", "git status")).toBeUndefined();
		expect(
			parseRtkRewriteOutput(3, "git status", "git status"),
		).toBeUndefined();
		expect(
			parseRtkRewriteOutput(99, "rtk git status", "git status"),
		).toBeUndefined();
	});
});

describe("rewriteChain", () => {
	it("applies official rewrite then bun-test overlay", async () => {
		const lookup: RtkRewriteLookup = (cmd) =>
			cmd === "bun test && git status"
				? "bun test && rtk git status"
				: undefined;
		expect(await rewriteChain("bun test && git status", lookup)).toBe(
			"rtk test bun test && rtk git status",
		);
	});

	it("leaves lookup misses unchanged except bun test", async () => {
		const lookup: RtkRewriteLookup = () => undefined;
		expect(await rewriteChain("echo hi && mkdir x", lookup)).toBe(
			"echo hi && mkdir x",
		);
		expect(await rewriteChain("bun pm pack", lookup)).toBe("bun pm pack");
		expect(await rewriteChain("bun run test", lookup)).toBe("bun run test");
		expect(await rewriteChain("npm publish --access public", lookup)).toBe(
			"npm publish --access public",
		);
		expect(await rewriteChain("bun test src/rtk.test.ts", lookup)).toBe(
			"rtk test bun test src/rtk.test.ts",
		);
		expect(await rewriteChain("FOO=1 bun test", lookup)).toBe(
			"FOO=1 rtk test bun test",
		);
	});

	it("unwraps rtk find when the command uses -not/-exec", async () => {
		const cmd = "find . -type f -not -path '*/node_modules/*'";
		const lookup: RtkRewriteLookup = () => `rtk ${cmd}`;
		expect(await rewriteChain(cmd, lookup)).toBe(cmd);
	});

	it("keeps rtk find when predicates are safe", async () => {
		const lookup: RtkRewriteLookup = () => "rtk find . -name '*.ts'";
		expect(await rewriteChain("find . -name '*.ts'", lookup)).toBe(
			"rtk find . -name '*.ts'",
		);
	});

	it("does not call lookup for already-rtk commands, including env prefixes", async () => {
		let called = false;
		const lookup: RtkRewriteLookup = () => {
			called = true;
			return "rtk rtk git status";
		};
		expect(await rewriteChain("rtk git status", lookup)).toBe("rtk git status");
		expect(await rewriteChain("CI=1 rtk git status", lookup)).toBe(
			"CI=1 rtk git status",
		);
		expect(called).toBe(false);
	});

	it("skips unparseable commands without calling lookup", async () => {
		let called = false;
		const lookup: RtkRewriteLookup = () => {
			called = true;
			return "rtk git status";
		};
		const cmd = 'git commit -m "oops';
		expect(await rewriteChain(cmd, lookup)).toBe(cmd);
		expect(called).toBe(false);
	});
});

const hasRtk = Bun.which("rtk") !== null;

describe.skipIf(!hasRtk)("rewriteChain via rtk rewrite", () => {
	it("rewrites supported chains the way rtk rewrite does", async () => {
		expect(await rewriteChain("git status")).toBe("rtk git status");
		expect(await rewriteChain("git add . && git commit -m x && git push")).toBe(
			"rtk git add . && rtk git commit -m x && rtk git push",
		);
		expect(await rewriteChain("cargo test && npm publish")).toBe(
			"rtk cargo test && npm publish",
		);
		expect(await rewriteChain("npm run build")).toBe("rtk npm run build");
		expect(await rewriteChain("npx tsc --noEmit")).toBe("rtk tsc --noEmit");
	});

	it("does not wrap registry, login, or npm test", async () => {
		expect(await rewriteChain("npm publish --access public")).toBe(
			"npm publish --access public",
		);
		expect(await rewriteChain("npm test")).toBe("npm test");
		expect(await rewriteChain("cargo publish")).toBe("cargo publish");
		expect(await rewriteChain("docker login")).toBe("docker login");
	});

	it("wraps bun test even though rtk rewrite does not", async () => {
		expect(await rewriteChain("bun test")).toBe("rtk test bun test");
		expect(await rewriteChain("bun test && npm publish --access public")).toBe(
			"rtk test bun test && npm publish --access public",
		);
	});

	it("inserts rtk after env assignments", async () => {
		expect(await rewriteChain("FOO=1 cargo test")).toBe("FOO=1 rtk cargo test");
	});
});

// ── detectSudoSegments ───────────────────────────────────────────────────────

describe("detectSudoSegments", () => {
	it("returns empty for command with no sudo", () => {
		expect(detectSudoSegments(["git status"])).toEqual([]);
	});

	it("detects a plain sudo segment", () => {
		expect(detectSudoSegments(["sudo apt-get install foo"])).toEqual([
			"sudo apt-get install foo",
		]);
	});

	it("detects sudo in a chain (operators excluded)", () => {
		const parts = ["git status ", "&&", " sudo make install"];
		expect(detectSudoSegments(parts)).toEqual(["sudo make install"]);
	});

	it("detects multiple sudo segments", () => {
		const parts = ["sudo rm -rf /tmp ", ";", " sudo reboot"];
		expect(detectSudoSegments(parts)).toEqual([
			"sudo rm -rf /tmp",
			"sudo reboot",
		]);
	});

	it("does not match 'sudoer' or 'pseudo'", () => {
		expect(detectSudoSegments(["sudoers-check", "pseudo sudo"])).toEqual([]);
	});

	it("returns empty for operators-only parts", () => {
		expect(detectSudoSegments(["&&", "||", ";"])).toEqual([]);
	});
});

// ── buildSudoBlockReason ──────────────────────────────────────────────────────

describe("buildSudoBlockReason", () => {
	it("with sudo_run available: mentions sudo_run tool", () => {
		const reason = buildSudoBlockReason(["sudo apt install curl"], true);
		expect(reason).toContain("sudo_run");
		expect(reason).toContain("sudo apt install curl");
		expect(reason).not.toContain("not available");
	});

	it("with sudo_run available: instructs to strip sudo prefix", () => {
		const reason = buildSudoBlockReason(["sudo make install"], true);
		expect(reason).toContain("Strip the leading");
	});

	it("without sudo_run: explains restriction and asks user to run manually", () => {
		const reason = buildSudoBlockReason(["sudo reboot"], false);
		expect(reason).toContain("no sudo_run tool is available");
		expect(reason).toContain("manually");
		expect(reason).toContain("sudo reboot");
	});

	it("lists all blocked commands", () => {
		const reason = buildSudoBlockReason(
			["sudo rm -rf /tmp", "sudo reboot"],
			true,
		);
		expect(reason).toContain("sudo rm -rf /tmp");
		expect(reason).toContain("sudo reboot");
	});
});

// Integration tests for the `tool_call` hook step. These guard the bug that
// silently disabled rewriting: wrong event name + wrong field + wrong patch
// mechanism. They assert on the IN-PLACE mutation contract the SDK requires.
describe("applyRtkRewrite (tool_call hook step)", () => {
	it("mutates event.input.command in place for a known bash command", async () => {
		const event = bashEvent("git status");
		const changed = await applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
			rewrite: (cmd) => (cmd === "git status" ? "rtk git status" : undefined),
		});
		expect(changed).toBe(true);
		expect(event.input.command).toBe("rtk git status");
	});

	it("rewrites every segment of a chain in place", async () => {
		const event = bashEvent("git add . && git push");
		await applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
			rewrite: (cmd) =>
				cmd === "git add . && git push"
					? "rtk git add . && rtk git push"
					: undefined,
		});
		expect(event.input.command).toBe("rtk git add . && rtk git push");
	});

	it("does not mutate when disabled", async () => {
		const event = bashEvent("git status");
		const changed = await applyRtkRewrite(event, {
			enabled: false,
			rtkAvailable: true,
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe("git status");
	});

	it("does not mutate when rtk binary is unavailable", async () => {
		const event = bashEvent("git status");
		const changed = await applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: false,
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe("git status");
	});

	it("ignores non-bash tools", async () => {
		const event: BashCallEvent = {
			toolName: "grep",
			input: { command: "git status" },
		};
		const changed = await applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe("git status");
	});

	it("leaves unknown commands untouched", async () => {
		const event = bashEvent("mkdir build && cd build");
		const changed = await applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
			rewrite: () => undefined,
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe("mkdir build && cd build");
	});

	it("does not double-prefix an already-rtk command", async () => {
		const event = bashEvent("rtk git status");
		const changed = await applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
			rewrite: () => "rtk rtk git status",
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe("rtk git status");
	});

	it("handles missing / non-string command safely", async () => {
		const event: BashCallEvent = { toolName: "bash", input: {} };
		expect(
			await applyRtkRewrite(event, { enabled: true, rtkAvailable: true }),
		).toBe(false);
		const event2: BashCallEvent = { toolName: "bash", input: { command: 123 } };
		expect(
			await applyRtkRewrite(event2, { enabled: true, rtkAvailable: true }),
		).toBe(false);
	});

	it("leaves command unchanged on unbalanced quotes", async () => {
		const event = bashEvent('git commit -m "oops');
		const changed = await applyRtkRewrite(event, {
			enabled: true,
			rtkAvailable: true,
			rewrite: () => "rtk git status",
		});
		expect(changed).toBe(false);
		expect(event.input.command).toBe('git commit -m "oops');
	});
});
