/**
 * Machine-wide cap on concurrent headless runs.
 *
 * Every headless launch (`-p`, `--mode text|json`, or stdin without a terminal) holds one
 * exclusive OS lock `slot{i}` (i < N) in a directory shared by every omp profile, from before
 * its session is created until the process exits. N is `headless.maxConcurrent` from the
 * active profile's global config; `OMP_HEADLESS_SLOTS` can only lower it, so a runner cannot
 * raise the cap for the runs it starts. The gate locks only its own directory and never waits
 * on locks a runner holds, so it cannot form a wait cycle with runners that gate themselves.
 *
 * Deliberately free of the settings graph: the gate runs before `main` loads.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	$env,
	type FileLockHandle,
	getAgentDir,
	getHeadlessGateDir,
	isEnoent,
	isRecord,
	logger,
	MAIN_CONFIG_FILENAMES,
	tryAcquireFileLock,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { YAML } from "bun";
import type { Args } from "./args";

/** Default `headless.maxConcurrent`: headless runs allowed at once on one machine. */
export const DEFAULT_HEADLESS_MAX_CONCURRENT = 12;

/** Exit status of a headless run whose `--max-time` passed while it waited for a slot (`EX_TEMPFAIL`). */
export const HEADLESS_SLOT_TIMEOUT_EXIT_CODE = 75;

const HEADLESS_SLOT_POLL_MS = 250;

/** A held slot; the lock lives until `handle.release()` or process exit. */
export interface HeadlessSlot {
	handle: FileLockHandle;
	slot: number;
}

/** Rejects a `headless.maxConcurrent` that is not a positive integer; unset (`undefined`/`null`) passes. */
export function validateHeadlessMaxConcurrent(raw: unknown): asserts raw is number | null | undefined {
	if (raw === undefined || raw === null || (typeof raw === "number" && Number.isInteger(raw) && raw > 0)) return;
	throw new Error(`Invalid headless.maxConcurrent: expected a positive integer, got ${Bun.inspect(raw)}.`);
}

/**
 * Slot count for this launch: the configured cap, lowered by a positive `OMP_HEADLESS_SLOTS`.
 * Empty, non-numeric, zero and negative values are ignored, and a larger value never raises the cap.
 */
export function resolveHeadlessSlotLimit(configured: number, envRaw: string | undefined): number {
	const requested = envRaw ? Number.parseInt(envRaw, 10) : Number.NaN;
	return requested > 0 ? Math.min(configured, requested) : configured;
}

/**
 * Whether a root-command launch runs headless and takes a slot. Mirrors `runRootCommand`'s mode
 * choice: `--version` and `--export` exit before any session, protocol modes own a client
 * connection, and a terminal launch without `-p`/`--mode` is interactive.
 */
export function isHeadlessLaunch(
	parsed: Pick<Args, "print" | "mode" | "version" | "export">,
	stdinIsTTY: boolean,
): boolean {
	if (parsed.version || parsed.export) return false;
	if (parsed.mode === "rpc" || parsed.mode === "rpc-ui" || parsed.mode === "acp") return false;
	return parsed.print === true || parsed.mode !== undefined || !stdinIsTTY;
}

/** Lock the lowest free `slot{i}` in `dir` for i < `limit`, without waiting. */
function takeFreeSlot(dir: string, limit: number): HeadlessSlot | null {
	for (let slot = 0; slot < limit; slot++) {
		const handle = tryAcquireFileLock(path.join(dir, `slot${slot}`));
		if (handle) return { handle, slot };
	}
	return null;
}

/**
 * Poll every `pollMs` until one of `limit` slots in `dir` is free and lock it; `null` once
 * `deadline` (epoch ms) passes first. Waiters are not served in arrival order.
 */
export async function waitForHeadlessSlot(options: {
	dir: string;
	limit: number;
	deadline?: number;
	pollMs?: number;
}): Promise<HeadlessSlot | null> {
	const { dir, limit, deadline, pollMs = HEADLESS_SLOT_POLL_MS } = options;
	while (true) {
		const slot = takeFreeSlot(dir, limit);
		if (slot) return slot;
		const remainingMs = deadline === undefined ? pollMs : deadline - Date.now();
		if (remainingMs <= 0) return null;
		await Bun.sleep(Math.min(pollMs, remainingMs));
	}
}

/** `headless.maxConcurrent` as written in the active profile's global config, before validation. */
async function readConfiguredMaxConcurrent(): Promise<unknown> {
	for (const filename of MAIN_CONFIG_FILENAMES) {
		let text: string;
		try {
			text = await Bun.file(path.join(getAgentDir(), filename)).text();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		let config: unknown;
		try {
			config = YAML.parse(text);
		} catch {
			// Settings reports the malformed file when it loads; the gate keeps the default cap.
			return undefined;
		}
		const headless = isRecord(config) ? config.headless : undefined;
		return isRecord(headless) ? headless.maxConcurrent : undefined;
	}
	return undefined;
}

// Strong reference for the process lifetime: the native lock releases when its handle is collected.
let heldSlot: HeadlessSlot | undefined;

/**
 * Hold a headless slot for the rest of the process, waiting while all N are taken. Waiting
 * counts against `--max-time`: `parsed.maxTime` becomes the time left once a slot is held, and a
 * deadline that passes first exits {@link HEADLESS_SLOT_TIMEOUT_EXIT_CODE}. An invalid
 * `headless.maxConcurrent` exits 1. Non-headless launches return at once.
 */
export async function enterHeadlessGate(parsed: Args, stdinIsTTY = process.stdin.isTTY === true): Promise<void> {
	if (heldSlot || !isHeadlessLaunch(parsed, stdinIsTTY)) return;
	const configured = await readConfiguredMaxConcurrent();
	try {
		validateHeadlessMaxConcurrent(configured);
	} catch (error) {
		process.stderr.write(`${chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`)}\n`);
		process.exit(1);
	}
	const limit = resolveHeadlessSlotLimit(configured ?? DEFAULT_HEADLESS_MAX_CONCURRENT, $env.OMP_HEADLESS_SLOTS);
	const dir = getHeadlessGateDir();
	await fs.mkdir(dir, { recursive: true });
	const startedAt = Date.now();
	const deadline = parsed.maxTime === undefined ? undefined : startedAt + parsed.maxTime * 1000;
	let slot = takeFreeSlot(dir, limit);
	if (!slot) {
		process.stderr.write(`${chalk.dim(`Waiting for a headless slot: all ${limit} are in use (${dir})…`)}\n`);
		slot = await waitForHeadlessSlot({ dir, limit, deadline });
	}
	const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
	if (!slot || (remainingMs !== undefined && remainingMs <= 0)) {
		process.stderr.write(`headless slot wait timed out (N=${limit})\n`);
		process.exit(HEADLESS_SLOT_TIMEOUT_EXIT_CODE);
	}
	heldSlot = slot;
	if (remainingMs !== undefined) parsed.maxTime = remainingMs / 1000;
	logger.debug("Headless slot acquired", { slot: slot.slot, limit, waitedMs: Date.now() - startedAt });
}
