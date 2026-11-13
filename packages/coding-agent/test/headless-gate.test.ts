import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	HEADLESS_SLOT_TIMEOUT_EXIT_CODE,
	type HeadlessSlot,
	isHeadlessLaunch,
	resolveHeadlessSlotLimit,
	waitForHeadlessSlot,
} from "@oh-my-pi/pi-coding-agent/cli/headless-gate";
import { cfgHeadlessMaxConcurrent } from "@oh-my-pi/pi-coding-agent/cli/headless-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type FileLockHandle, tryAcquireFileLock } from "@oh-my-pi/pi-utils/file-lock";

// Machine-wide cap on concurrent headless runs. Before: every `omp -p` started at
// once, so runners with separate gates together launched 91 runs and exhausted
// the memory of an 18 GB laptop.

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const MODEL_ARGS = ["--provider", "anthropic", "--model", "claude-sonnet-4-5"];

function holdSlot(dir: string, slot: number): FileLockHandle {
	const handle = tryAcquireFileLock(path.join(dir, `slot${slot}`));
	if (!handle) throw new Error(`slot${slot} in ${dir} is already held`);
	return handle;
}

function gateDir(tempDir: TempDir): string {
	const dir = tempDir.join("gate");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

interface LaunchRun {
	exitCode: number;
	stderr: string;
}

/** Launch the CLI under an isolated home whose gate dir and global config the test controls. */
async function launchHeadless(
	home: string,
	args: string[],
	{ config, env = {} }: { config?: string; env?: Record<string, string> } = {},
): Promise<LaunchRun> {
	const agentDir = path.join(home, ".omp", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	if (config !== undefined) fs.writeFileSync(path.join(agentDir, "config.yml"), config);
	const proc = Bun.spawn([process.execPath, cliEntry, "--no-session", "--no-extensions", ...MODEL_ARGS, ...args], {
		cwd: home,
		env: {
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
			TMP: process.env.TMP,
			TEMP: process.env.TEMP,
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			HOME: home,
			USERPROFILE: home,
			NO_COLOR: "1",
			// CI can run on EC2 even when no credential variables are inherited.
			AWS_EC2_METADATA_DISABLED: "true",
			...env,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return { exitCode, stderr };
}

/** Hold `slot0` of the gate dir a launch under `home` competes for. */
function holdLaunchSlot(home: string): FileLockHandle {
	const dir = path.join(home, ".omp", "run", "headless-gate");
	fs.mkdirSync(dir, { recursive: true });
	return holdSlot(dir, 0);
}

describe("headless slot wait", () => {
	it("keeps a third run pending with N=2 until a holder releases, then hands it the freed slot", async () => {
		using tempDir = TempDir.createSync("@omp-headless-gate-");
		const dir = gateDir(tempDir);
		const first = holdSlot(dir, 0);
		const second = holdSlot(dir, 1);
		let third: HeadlessSlot | null = null;
		try {
			const waiting = waitForHeadlessSlot({ dir, limit: 2, deadline: Date.now() + 10_000, pollMs: 10 });
			const pending = Symbol("pending");
			expect(await Promise.race([waiting, Bun.sleep(150).then(() => pending)])).toBe(pending);
			first.release();
			third = await waiting;
			expect(third?.slot).toBe(0);
		} finally {
			third?.handle.release();
			first.release();
			second.release();
		}
	});

	it("gives up with null once the deadline passes while every slot stays held", async () => {
		using tempDir = TempDir.createSync("@omp-headless-gate-");
		const dir = gateDir(tempDir);
		const only = holdSlot(dir, 0);
		try {
			const startedAt = Date.now();
			expect(await waitForHeadlessSlot({ dir, limit: 1, deadline: startedAt + 50, pollMs: 10 })).toBeNull();
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
		} finally {
			only.release();
		}
	});
});

describe("headless slot limit", () => {
	it("cannot raise the configured cap through OMP_HEADLESS_SLOTS, only lower it", () => {
		expect(resolveHeadlessSlotLimit(12, "44")).toBe(12);
		expect(resolveHeadlessSlotLimit(12, "4")).toBe(4);
		for (const ignored of [undefined, "", "0", "-3", "abc"]) {
			expect(resolveHeadlessSlotLimit(12, ignored)).toBe(12);
		}
	});
});

describe("headless launch classification", () => {
	it("gates print, text/json and piped launches but not protocol modes, terminals, --version or --export", () => {
		const gated = (args: string[], stdinIsTTY = true) => isHeadlessLaunch(parseArgs(args), stdinIsTTY);
		expect(gated(["-p", "hi"])).toBe(true);
		expect(gated(["--mode", "json", "hi"])).toBe(true);
		expect(gated(["--mode", "text", "hi"])).toBe(true);
		expect(gated(["hi"], false)).toBe(true);
		expect(gated(["hi"])).toBe(false);
		expect(gated(["--mode", "rpc"], false)).toBe(false);
		expect(gated(["--mode", "rpc-ui"], false)).toBe(false);
		expect(gated(["--mode", "acp"], false)).toBe(false);
		expect(gated(["--version"], false)).toBe(false);
		expect(gated(["--export", "session.jsonl"], false)).toBe(false);
	});
});

describe("headless.maxConcurrent", () => {
	it("defaults to 12 and rejects a value that is not a positive integer", () => {
		expect(cfgHeadlessMaxConcurrent.get(Settings.isolated())).toBe(12);
		for (const value of [0, -1, 1.5, "4"]) {
			expect(() => Settings.isolated({ "headless.maxConcurrent": value })).toThrow("Invalid headless.maxConcurrent");
		}
	});
});

describe("headless launch gate", () => {
	it("exits 75 naming N when --max-time passes while its only slot is held", async () => {
		using tempDir = TempDir.createSync("@omp-headless-gate-");
		const home = tempDir.path();
		const held = holdLaunchSlot(home);
		try {
			const run = await launchHeadless(home, ["-p", "--max-time", "1", "hi"], { env: { OMP_HEADLESS_SLOTS: "1" } });
			expect(run.stderr).toContain("headless slot wait timed out (N=1)");
			expect(run.exitCode).toBe(HEADLESS_SLOT_TIMEOUT_EXIT_CODE);
		} finally {
			held.release();
		}
	}, 30_000);

	it("cannot raise a configured cap of 1 through OMP_HEADLESS_SLOTS=5", async () => {
		using tempDir = TempDir.createSync("@omp-headless-gate-");
		const home = tempDir.path();
		const held = holdLaunchSlot(home);
		try {
			// A raised cap would take slot1 and fail later on the missing API key (exit 1).
			const run = await launchHeadless(home, ["-p", "--max-time", "1", "hi"], {
				config: "headless:\n  maxConcurrent: 1\n",
				env: { OMP_HEADLESS_SLOTS: "5" },
			});
			expect(run.stderr).toContain("headless slot wait timed out (N=1)");
			expect(run.exitCode).toBe(HEADLESS_SLOT_TIMEOUT_EXIT_CODE);
		} finally {
			held.release();
		}
	}, 30_000);

	it("rejects a launch whose headless.maxConcurrent is 0, naming the setting", async () => {
		using tempDir = TempDir.createSync("@omp-headless-gate-");
		const run = await launchHeadless(tempDir.path(), ["-p", "hi"], { config: "headless:\n  maxConcurrent: 0\n" });
		expect(run.stderr).toContain("Invalid headless.maxConcurrent");
		expect(run.exitCode).toBe(1);
	}, 30_000);
});
