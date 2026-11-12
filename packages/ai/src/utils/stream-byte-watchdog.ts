import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { createAbortSourceTracker, raceWithSignal } from "./abort";

export type StreamByteWatchdogPhase = "first-byte" | "idle";

export interface StreamByteWatchdog {
	/** Caller signal merged with the watchdog; hand it to the transport (fetch + body reads). */
	readonly signal: AbortSignal;
	/** Report a raw body chunk. Every nonempty chunk counts as progress, whatever it contains. */
	onBytes(byteLength: number): void;
	/** Stop the timer and detach listeners. Never aborts the transport. */
	clear(): void;
	/** The timeout that aborted the transport, unless the caller aborted too (caller intent wins). */
	readonly error: AIError.StreamTimeoutError | undefined;
	/**
	 * Race `operation` against `signal` so a transport that ignores abort still settles.
	 * Rejects with the caller's reason on caller abort, else with the watchdog timeout.
	 */
	run<T>(operation: Promise<T>): Promise<T>;
}

/**
 * Raw-byte watchdog for a streaming HTTP request.
 *
 * The first-byte budget runs from creation through response headers until the
 * first nonempty body chunk; the idle budget then bounds the gap between
 * nonempty chunks. Thinking deltas, SSE comments and partial frames all count,
 * so only true transport silence trips it. `0`/`undefined` disables a budget.
 *
 * Chunks only record a timestamp; the single timer re-arms itself for the
 * remaining gap when it fires early relative to the latest chunk.
 */
export function armStreamByteWatchdog(
	callerSignal: AbortSignal | undefined,
	firstByteTimeoutMs: number | undefined,
	idleTimeoutMs: number | undefined,
	endpoint: string,
): StreamByteWatchdog {
	const tracker = createAbortSourceTracker(callerSignal);
	const { requestSignal: signal } = tracker;
	const idleBudgetMs = idleTimeoutMs !== undefined && idleTimeoutMs > 0 ? idleTimeoutMs : undefined;
	const startedAt = Date.now();
	let lastByteAt: number | undefined;
	let timer: NodeJS.Timeout | undefined;
	let armed = true;
	let timeoutError: AIError.StreamTimeoutError | undefined;

	const schedule = (delayMs: number): void => {
		timer = setTimeout(onTimer, delayMs);
		timer.unref?.();
	};

	const disarm = (): void => {
		armed = false;
		clearTimeout(timer);
		timer = undefined;
		signal.removeEventListener("abort", disarm);
	};

	const expire = (phase: StreamByteWatchdogPhase, elapsedMs: number): void => {
		logger.warn("Stream byte watchdog timed out; aborting transport.", { endpoint, phase, elapsedMs });
		timeoutError = new AIError.StreamTimeoutError(
			phase === "first-byte"
				? `Stream received no bytes from ${endpoint} within ${elapsedMs}ms`
				: `Stream from ${endpoint} stalled: no bytes for ${elapsedMs}ms`,
		);
		tracker.abortLocally(timeoutError);
	};

	function onTimer(): void {
		timer = undefined;
		const now = Date.now();
		if (lastByteAt === undefined) {
			expire("first-byte", now - startedAt);
			return;
		}
		const gapMs = now - lastByteAt;
		if (gapMs >= idleBudgetMs!) {
			expire("idle", gapMs);
			return;
		}
		schedule(idleBudgetMs! - gapMs);
	}

	if (firstByteTimeoutMs !== undefined && firstByteTimeoutMs > 0) schedule(firstByteTimeoutMs);
	signal.addEventListener("abort", disarm, { once: true });

	return {
		signal,
		onBytes(byteLength) {
			if (byteLength === 0) return;
			const firstByte = lastByteAt === undefined;
			lastByteAt = Date.now();
			if (!firstByte || !armed) return;
			clearTimeout(timer);
			timer = undefined;
			if (idleBudgetMs !== undefined) schedule(idleBudgetMs);
		},
		clear: disarm,
		get error() {
			return tracker.wasCallerAbort() ? undefined : timeoutError;
		},
		async run(operation) {
			try {
				return await raceWithSignal(operation, signal);
			} catch (err) {
				if (callerSignal?.aborted) throw callerSignal.reason;
				throw timeoutError ?? err;
			}
		},
	};
}
