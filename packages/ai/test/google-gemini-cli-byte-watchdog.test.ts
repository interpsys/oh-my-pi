import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getAntigravityProviderSessionState, streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";
import type { Socket, TCPSocketListener } from "bun";

/**
 * Byte-level stream watchdog for Cloud Code Assist (Antigravity + Gemini CLI),
 * exercised against a real local HTTP/1.1 server so connection pooling, header
 * flushing and chunk timing are the runtime's, not a mocked `Response`.
 *
 * The server is raw TCP rather than `Bun.serve`: `Bun.serve` holds response
 * headers until the first body byte, so it cannot model "headers, then silence".
 *
 * Real timers are deliberate: fake timers cannot drive socket I/O, Bun's
 * connection pool or the provider's watchdog against actual chunk arrival.
 */

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const WATCHDOG_MS = 80;
/** Gap between trickled chunks: well inside the watchdog budget. */
const TRICKLE_GAP_MS = 25;
/** Bound on recovery wall time: one watchdog budget plus generous scheduling slack. */
const RECOVERY_BOUND_MS = 1_500;
/** Test-safety ceiling only; a stream that never settles fails here instead of hanging the run. */
const TEST_SAFETY_MS = 5_000;
const TEST_TIMEOUT_MS = 10_000;

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: DAILY_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});
const geminiCliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash (Cloud Code Assist)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: GEMINI_CLI_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

// Pinning the client version keeps the Antigravity manifest lookup off the
// injected fetch, which only models CCA endpoints.
const savedAntigravityVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
beforeEach(() => {
	process.env.PI_AI_ANTIGRAVITY_VERSION = "2.19.1";
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedAntigravityVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
	else process.env.PI_AI_ANTIGRAVITY_VERSION = savedAntigravityVersion;
});

// ---------------------------------------------------------------------------
// Fake Cloud Code Assist server
// ---------------------------------------------------------------------------

interface Connection {
	remotePort: number;
	buffer: Buffer;
	requests: number;
	isClosed: boolean;
	closed: PromiseWithResolvers<void>;
}

/** One CCA request as the server saw it. */
interface Exchange {
	/** Real endpoint the provider addressed, recovered from the rewritten URL. */
	readonly endpoint: string;
	readonly remotePort: number;
	/** 0 when this request opened its connection; >0 means a reused (pooled) socket. */
	readonly requestOnConnection: number;
	/** Resolves when the client closes the connection carrying this request. */
	readonly closed: Promise<void>;
	isClosed(): boolean;
	sendHeaders(): void;
	/** Writes one nonempty HTTP chunk, flushed as its own body read. */
	sendChunk(text: string): void;
	finish(): void;
	/** Sends a complete non-streaming response with `status`. */
	sendStatus(status: number, body: string): void;
	/** Closes the connection without a response. */
	hangUp(): void;
}

/** One call the provider made through the injected fetch. */
interface FetchCall {
	readonly endpoint: string;
	readonly keepalive: boolean | undefined;
	readonly signal: AbortSignal | undefined;
}

interface FakeCcaServer {
	readonly exchanges: Exchange[];
	readonly fetchCalls: FetchCall[];
	readonly warmPorts: number[];
	readonly fetch: FetchImpl;
	/** Leaves two idle keep-alive sockets in the client pool so a pooled retry is observable. */
	warmPool(): Promise<void>;
	stop(): Promise<void>;
}

const WARM_PATH = "/__warm";

function startFakeCcaServer(handler: (exchange: Exchange) => void | Promise<void>): FakeCcaServer {
	const exchanges: Exchange[] = [];
	const fetchCalls: FetchCall[] = [];
	const warmPorts: number[] = [];
	const sockets = new Set<Socket<Connection>>();
	const handlers = new Set<Promise<void>>();

	const dispatch = (socket: Socket<Connection>, target: string): void => {
		const connection = socket.data;
		const requestOnConnection = connection.requests++;
		const write = (bytes: string): void => {
			if (!connection.isClosed) socket.write(bytes);
		};

		if (target === WARM_PATH) {
			warmPorts.push(connection.remotePort);
			// Answer after both warm-up requests are in flight so they hold distinct sockets.
			setTimeout(() => write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"), 20);
			return;
		}

		const host = target.split("/")[1] ?? "";
		const exchange: Exchange = {
			endpoint: `https://${host}`,
			remotePort: connection.remotePort,
			requestOnConnection,
			closed: connection.closed.promise,
			isClosed: () => connection.isClosed,
			sendHeaders: () =>
				write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n"),
			sendChunk: text => {
				if (text === "") throw new Error("an empty HTTP chunk terminates the body");
				write(`${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`);
			},
			finish: () => write("0\r\n\r\n"),
			sendStatus: (status, body) =>
				write(
					`HTTP/1.1 ${status} Status\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
				),
			hangUp: () => socket.end(),
		};
		exchanges.push(exchange);
		const handled = Promise.resolve().then(() => handler(exchange));
		handlers.add(handled);
	};

	const listener: TCPSocketListener<Connection> = Bun.listen<Connection>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				// `remotePort` is unavailable once the socket closes; capture it now.
				socket.data = {
					remotePort: socket.remotePort,
					buffer: Buffer.alloc(0),
					requests: 0,
					isClosed: false,
					closed: Promise.withResolvers<void>(),
				};
				sockets.add(socket);
			},
			data(socket, chunk) {
				const connection = socket.data;
				connection.buffer = Buffer.concat([connection.buffer, chunk]);
				for (;;) {
					const headEnd = connection.buffer.indexOf("\r\n\r\n");
					if (headEnd < 0) return;
					const head = connection.buffer.subarray(0, headEnd).toString("latin1");
					const contentLength = Number(/^content-length:\s*(\d+)\s*$/im.exec(head)?.[1] ?? 0);
					const requestEnd = headEnd + 4 + contentLength;
					if (connection.buffer.byteLength < requestEnd) return;
					connection.buffer = connection.buffer.subarray(requestEnd);
					const requestLine = head.slice(0, head.indexOf("\r\n"));
					dispatch(socket, requestLine.split(" ")[1] ?? "/");
				}
			},
			close(socket) {
				socket.data.isClosed = true;
				socket.data.closed.resolve();
				sockets.delete(socket);
			},
		},
	});
	const origin = `http://127.0.0.1:${listener.port}`;

	// Route every real CCA URL to the local server, keeping the endpoint host as
	// the first path segment; URLs already local (empty-stream retries reuse
	// `response.url`) pass through unchanged.
	const toLocalUrl = (url: string): string => {
		if (url.startsWith(origin)) return url;
		const parsed = new URL(url);
		return `${origin}/${parsed.host}${parsed.pathname}${parsed.search}`;
	};
	const fetchImpl: FetchImpl = (input, init) => {
		const localUrl = toLocalUrl(input instanceof Request ? input.url : input.toString());
		const host = new URL(localUrl).pathname.split("/")[1] ?? "";
		fetchCalls.push({
			endpoint: `https://${host}`,
			keepalive: init?.keepalive,
			signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
		});
		return input instanceof Request ? fetch(new Request(localUrl, input), init) : fetch(localUrl, init);
	};

	return {
		exchanges,
		fetchCalls,
		warmPorts,
		fetch: fetchImpl,
		async warmPool() {
			await Promise.all([0, 1].map(() => fetch(`${origin}${WARM_PATH}`).then(response => response.text())));
			expect(new Set(warmPorts).size).toBe(2);
		},
		async stop() {
			for (const socket of sockets) {
				socket.data.isClosed = true;
				socket.data.closed.resolve();
				socket.end();
			}
			listener.stop(true);
			await Promise.allSettled(handlers);
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sseEvent(response: Record<string, unknown>): string {
	return `data: ${JSON.stringify({ response })}\n\n`;
}

function thinkingEvent(thinking: string): string {
	return sseEvent({ candidates: [{ content: { role: "model", parts: [{ text: thinking, thought: true }] } }] });
}

function partialTextEvent(text: string): string {
	return sseEvent({ candidates: [{ content: { role: "model", parts: [{ text }] } }] });
}

function finalTextEvent(text: string): string {
	return sseEvent({
		responseId: "resp-1",
		candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
	});
}

function respondWithText(exchange: Exchange, text: string): void {
	exchange.sendHeaders();
	exchange.sendChunk(finalTextEvent(text));
	exchange.finish();
}

/** Splits `text` into `parts` nonempty slices, cutting through SSE frames and JSON. */
function slices(text: string, parts: number): string[] {
	const size = Math.ceil(text.length / parts);
	const out: string[] = [];
	for (let start = 0; start < text.length; start += size) out.push(text.slice(start, start + size));
	return out;
}

/** Sends each chunk followed by a gap well inside the watchdog budget; stops once the client hangs up. */
async function trickle(exchange: Exchange, chunks: readonly string[]): Promise<void> {
	for (const chunk of chunks) {
		if (exchange.isClosed()) return;
		exchange.sendChunk(chunk);
		await Bun.sleep(TRICKLE_GAP_MS);
	}
}

/** True when the connection closed within `ms`. */
async function closedWithin(exchange: Exchange, ms: number): Promise<boolean> {
	const deadline = AbortSignal.timeout(ms);
	const { promise: expired, resolve } = Promise.withResolvers<boolean>();
	const onExpire = (): void => resolve(false);
	deadline.addEventListener("abort", onExpire, { once: true });
	try {
		return await Promise.race([exchange.closed.then(() => true), expired]);
	} finally {
		deadline.removeEventListener("abort", onExpire);
	}
}

interface Collected {
	events: AssistantMessageEvent[];
	message: AssistantMessage;
	settledAt: number;
}

async function collect(stream: AssistantMessageEventStream): Promise<Collected> {
	const events: AssistantMessageEvent[] = [];
	const safety = AbortSignal.timeout(TEST_SAFETY_MS);
	const { promise: expired, reject } = Promise.withResolvers<never>();
	const onExpire = (): void => reject(new Error(`stream did not settle within ${TEST_SAFETY_MS}ms (test safety)`));
	safety.addEventListener("abort", onExpire, { once: true });
	try {
		await Promise.race([
			(async () => {
				for await (const event of stream) events.push(event);
			})(),
			expired,
		]);
	} finally {
		safety.removeEventListener("abort", onExpire);
	}
	const settledAt = performance.now();
	const terminal = events.at(-1);
	if (terminal?.type === "done") return { events, message: terminal.message, settledAt };
	if (terminal?.type === "error") return { events, message: terminal.error, settledAt };
	throw new Error(`stream ended without a terminal event (last: ${terminal?.type ?? "none"})`);
}

function contentSummary(message: AssistantMessage): Array<[string, string]> {
	return message.content.map(block => {
		if (block.type === "text") return ["text", block.text];
		if (block.type === "thinking") return ["thinking", block.thinking];
		return [block.type, ""];
	});
}

function watchdogOptions(server: FakeCcaServer) {
	return {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		streamFirstEventTimeoutMs: WATCHDOG_MS,
		streamIdleTimeoutMs: WATCHDOG_MS,
		fetch: server.fetch,
	};
}

function spyOnWarn() {
	return vi.spyOn(logger, "warn").mockImplementation(() => {});
}

/** The timeout must be logged with the endpoint it stalled on and the elapsed silence. */
function expectTimeoutLogged(warn: { mock: { calls: unknown[][] } }, endpoint: string): void {
	const metadata = warn.mock.calls.map(call => call[1]);
	expect(metadata).toContainEqual(
		expect.objectContaining({
			endpoint: expect.stringContaining(new URL(endpoint).host),
			elapsedMs: expect.any(Number),
		}),
	);
}

/** A retry after a stall must open a new socket: never the stalled one, never an idle pooled one. */
function expectFreshConnection(server: FakeCcaServer, stalled: Exchange, retry: Exchange, retryCall: FetchCall): void {
	expect(retryCall.keepalive).toBe(false);
	expect(retry.requestOnConnection).toBe(0);
	expect(retry.remotePort).not.toBe(stalled.remotePort);
	expect(server.warmPorts).not.toContain(retry.remotePort);
}

/** How a fake endpoint withholds its response until the client gives up. */
type Silence = "no headers" | "headers, no body";

function holdSilent(exchange: Exchange, silence: Silence): Promise<void> {
	if (silence === "headers, no body") exchange.sendHeaders();
	return exchange.closed;
}

/**
 * Byte silence before any output must reach the session as the CCA empty
 * response: Antigravity Gemini continues with a changed prompt, other models
 * consult the fallback chain, and the generic retry that resends an unchanged
 * body never admits it, neither from the provider's id nor reclassified from text.
 */
function expectEscalatedToSession(message: AssistantMessage): void {
	expect(message.stopReason).toBe("error");
	expect(message.content).toEqual([]);
	expect(message.errorMessage).toStartWith("Cloud Code Assist API returned an empty response: ");
	const sessionId = AIError.classifyMessage({
		api: message.api,
		errorId: message.errorId,
		errorMessage: message.errorMessage,
		errorStatus: message.errorStatus,
	});
	for (const id of [message.errorId, sessionId]) {
		expect(AIError.retriable(id)).toBe(false);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(false);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test(
	"Antigravity fails over from a sandbox request that never sends headers to production on a fresh connection",
	async () => {
		const warn = spyOnWarn();
		const server = startFakeCcaServer(async exchange => {
			// Accept the request, then hold it open until the client gives up.
			if (exchange.endpoint === SANDBOX_ENDPOINT) return exchange.closed;
			respondWithText(exchange, "Recovered on production.");
		});
		try {
			await server.warmPool();
			const providerSessionState = new Map<string, ProviderSessionState>();
			const antigravityState = getAntigravityProviderSessionState(providerSessionState);
			if (!antigravityState) throw new Error("expected Antigravity provider session state");
			antigravityState.lastGoodEndpoint = SANDBOX_ENDPOINT;

			const startedAt = performance.now();
			const { message, settledAt } = await collect(
				streamGoogleGeminiCli(antigravityModel, context, { ...watchdogOptions(server), providerSessionState }),
			);

			expect(message.errorMessage).toBeUndefined();
			expect(message.stopReason).toBe("stop");
			expect(contentSummary(message)).toEqual([["text", "Recovered on production."]]);
			expect(settledAt - startedAt).toBeLessThan(RECOVERY_BOUND_MS);
			expect(server.fetchCalls.map(call => call.endpoint)).toEqual([SANDBOX_ENDPOINT, DAILY_ENDPOINT]);
			expect(server.exchanges.map(exchange => exchange.endpoint)).toEqual([SANDBOX_ENDPOINT, DAILY_ENDPOINT]);

			const [stalled, retry] = server.exchanges;
			expect(server.fetchCalls[0].signal?.aborted).toBe(true);
			expect(await closedWithin(stalled, RECOVERY_BOUND_MS)).toBe(true);
			expectFreshConnection(server, stalled, retry, server.fetchCalls[1]);
			expectTimeoutLogged(warn, SANDBOX_ENDPOINT);
			expect(antigravityState.lastGoodEndpoint).toBe(DAILY_ENDPOINT);
		} finally {
			await server.stop();
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"Antigravity aborts a response whose headers arrive but whose body never emits, then fails over",
	async () => {
		const warn = spyOnWarn();
		const server = startFakeCcaServer(async exchange => {
			if (exchange.endpoint === DAILY_ENDPOINT) {
				exchange.sendHeaders();
				return exchange.closed;
			}
			respondWithText(exchange, "Recovered on sandbox.");
		});
		try {
			await server.warmPool();
			const providerSessionState = new Map<string, ProviderSessionState>();

			const startedAt = performance.now();
			const { message, settledAt } = await collect(
				streamGoogleGeminiCli(antigravityModel, context, { ...watchdogOptions(server), providerSessionState }),
			);

			expect(message.errorMessage).toBeUndefined();
			expect(message.stopReason).toBe("stop");
			expect(contentSummary(message)).toEqual([["text", "Recovered on sandbox."]]);
			expect(settledAt - startedAt).toBeLessThan(RECOVERY_BOUND_MS);
			expect(server.exchanges.map(exchange => exchange.endpoint)).toEqual([DAILY_ENDPOINT, SANDBOX_ENDPOINT]);

			const [stalled, retry] = server.exchanges;
			expect(await closedWithin(stalled, RECOVERY_BOUND_MS)).toBe(true);
			expectFreshConnection(server, stalled, retry, server.fetchCalls[1]);
			expectTimeoutLogged(warn, DAILY_ENDPOINT);
			expect(getAntigravityProviderSessionState(providerSessionState)?.lastGoodEndpoint).toBe(SANDBOX_ENDPOINT);
		} finally {
			await server.stop();
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"every raw body byte counts: comments and partial SSE frames keep a slow stream alive past both budgets",
	async () => {
		const server = startFakeCcaServer(async exchange => {
			if (exchange.endpoint !== DAILY_ENDPOINT) {
				respondWithText(exchange, "Unexpected failover.");
				return;
			}
			exchange.sendHeaders();
			// ~250ms of SSE comments: bytes but no SSE event, well past the first-event budget.
			await trickle(
				exchange,
				Array.from({ length: 10 }, () => ": keepalive\n\n"),
			);
			// A thinking event cut mid-frame and mid-JSON; its slices together span more than the idle budget.
			await trickle(exchange, slices(thinkingEvent("Considering the request."), 6));
			// Between semantic events, only comments for longer than the idle budget.
			await trickle(
				exchange,
				Array.from({ length: 10 }, () => ":\n\n"),
			);
			await trickle(exchange, slices(finalTextEvent("Survived the slow stream."), 6));
			exchange.finish();
		});
		try {
			const startedAt = performance.now();
			const { events, message, settledAt } = await collect(
				streamGoogleGeminiCli(antigravityModel, context, {
					...watchdogOptions(server),
					providerSessionState: new Map<string, ProviderSessionState>(),
				}),
			);

			expect(message.errorMessage).toBeUndefined();
			expect(message.stopReason).toBe("stop");
			expect(contentSummary(message)).toEqual([
				["thinking", "Considering the request."],
				["text", "Survived the slow stream."],
			]);
			expect(server.fetchCalls.map(call => call.endpoint)).toEqual([DAILY_ENDPOINT]);
			expect(server.exchanges).toHaveLength(1);
			expect(events.filter(event => event.type === "start")).toHaveLength(1);
			// The fixture really outlived several watchdog budgets end to end.
			expect(settledAt - startedAt).toBeGreaterThan(WATCHDOG_MS * 4);
		} finally {
			await server.stop();
		}
	},
	TEST_TIMEOUT_MS,
);

test.each([
	{
		output: "thinking",
		chunk: thinkingEvent("Partial thought."),
		deltaType: "thinking_delta",
		delta: "Partial thought.",
	},
	{ output: "text", chunk: partialTextEvent("Partial answer."), deltaType: "text_delta", delta: "Partial answer." },
])(
	"a stall after $output has streamed escalates without replaying emitted deltas",
	async ({ chunk, deltaType, delta }) => {
		const warn = spyOnWarn();
		let outputSentAt = 0;
		const server = startFakeCcaServer(async exchange => {
			if (exchange.endpoint !== DAILY_ENDPOINT) {
				respondWithText(exchange, "Unsafe replay.");
				return;
			}
			exchange.sendHeaders();
			exchange.sendChunk(chunk);
			outputSentAt = performance.now();
			return exchange.closed;
		});
		try {
			const startedAt = performance.now();
			const { events, message, settledAt } = await collect(
				streamGoogleGeminiCli(antigravityModel, context, {
					...watchdogOptions(server),
					providerSessionState: new Map<string, ProviderSessionState>(),
				}),
			);

			expect(message.stopReason).toBe("error");
			expect(AIError.is(message.errorId, AIError.Flag.Timeout)).toBe(false);
			expect(AIError.retriable(message.errorId)).toBe(false);
			expect(message.errorMessage).toStartWith(
				deltaType === "thinking_delta"
					? "Cloud Code Assist API returned an empty response: "
					: "Cloud Code Assist API returned an incomplete response: ",
			);
			const sessionErrorId = AIError.classifyMessage({
				api: message.api,
				errorId: message.errorId,
				errorMessage: message.errorMessage,
				errorStatus: message.errorStatus,
			});
			expect(AIError.retriable(sessionErrorId)).toBe(false);
			expect(settledAt - startedAt).toBeLessThan(RECOVERY_BOUND_MS);
			// Bounded by the idle budget, and not tripped before it elapsed.
			expect(settledAt - outputSentAt).toBeGreaterThanOrEqual(WATCHDOG_MS * 0.75);
			expect(settledAt - outputSentAt).toBeLessThan(RECOVERY_BOUND_MS);

			// Output is committed downstream: no failover and no same-endpoint replay here.
			expect(server.fetchCalls.map(call => call.endpoint)).toEqual([DAILY_ENDPOINT]);
			expect(server.exchanges).toHaveLength(1);
			expect(events.filter(event => event.type === "start")).toHaveLength(1);
			const deltas = events.flatMap(event =>
				event.type === "thinking_delta" || event.type === "text_delta" ? [[event.type, event.delta]] : [],
			);
			expect(deltas).toEqual([[deltaType, delta]]);
			expect(await closedWithin(server.exchanges[0], RECOVERY_BOUND_MS)).toBe(true);
			expectTimeoutLogged(warn, DAILY_ENDPOINT);
		} finally {
			await server.stop();
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"caller abort surfaces as aborted and never fails over",
	async () => {
		const controller = new AbortController();
		const server = startFakeCcaServer(async exchange => {
			if (exchange.endpoint !== DAILY_ENDPOINT) {
				respondWithText(exchange, "Unexpected failover.");
				return;
			}
			controller.abort();
			return exchange.closed;
		});
		try {
			const startedAt = performance.now();
			const { message, settledAt } = await collect(
				streamGoogleGeminiCli(antigravityModel, context, {
					...watchdogOptions(server),
					providerSessionState: new Map<string, ProviderSessionState>(),
					signal: controller.signal,
				}),
			);
			// Outlast the watchdog budget so a late timeout-driven failover would show up.
			await Bun.sleep(WATCHDOG_MS * 3);

			expect(message.stopReason).toBe("aborted");
			expect(settledAt - startedAt).toBeLessThan(RECOVERY_BOUND_MS);
			expect(server.fetchCalls.map(call => call.endpoint)).toEqual([DAILY_ENDPOINT]);
			expect(server.exchanges.map(exchange => exchange.endpoint)).toEqual([DAILY_ENDPOINT]);
			expect(server.fetchCalls[0].signal?.aborted).toBe(true);
			expect(await closedWithin(server.exchanges[0], RECOVERY_BOUND_MS)).toBe(true);
		} finally {
			await server.stop();
		}
	},
	TEST_TIMEOUT_MS,
);

test.each([
	{ daily: "no headers", sandbox: "no headers" },
	{ daily: "headers, no body", sandbox: "headers, no body" },
	{ daily: "no headers", sandbox: "headers, no body" },
] as const)(
	"Antigravity auto mode sends one silent request per endpoint, then escalates (production: $daily, sandbox: $sandbox)",
	async ({ daily, sandbox }) => {
		spyOnWarn();
		const server = startFakeCcaServer(exchange =>
			holdSilent(exchange, exchange.endpoint === DAILY_ENDPOINT ? daily : sandbox),
		);
		try {
			const startedAt = performance.now();
			const { events, message, settledAt } = await collect(
				streamGoogleGeminiCli(antigravityModel, context, {
					...watchdogOptions(server),
					providerSessionState: new Map<string, ProviderSessionState>(),
					// A same-endpoint repeat shows up as a request count, not as backoff time.
					maxRetryDelayMs: 20,
				}),
			);

			expect(server.fetchCalls.map(call => call.endpoint)).toEqual([DAILY_ENDPOINT, SANDBOX_ENDPOINT]);
			expect(server.exchanges.map(exchange => exchange.endpoint)).toEqual([DAILY_ENDPOINT, SANDBOX_ENDPOINT]);
			expectEscalatedToSession(message);
			expect(events.some(event => event.type === "start")).toBe(false);
			expect(settledAt - startedAt).toBeLessThan(RECOVERY_BOUND_MS);
			for (const exchange of server.exchanges) expect(await closedWithin(exchange, RECOVERY_BOUND_MS)).toBe(true);
		} finally {
			await server.stop();
		}
	},
	TEST_TIMEOUT_MS,
);

test.each(["no headers", "headers, no body"] as const)(
	"explicit production endpoint sends one silent request (%s), then escalates",
	async silence => {
		spyOnWarn();
		const server = startFakeCcaServer(exchange => {
			if (exchange.endpoint !== DAILY_ENDPOINT) {
				respondWithText(exchange, "Unexpected endpoint.");
				return;
			}
			return holdSilent(exchange, silence);
		});
		try {
			const startedAt = performance.now();
			const { message, settledAt } = await collect(
				streamGoogleGeminiCli(antigravityModel, context, {
					...watchdogOptions(server),
					providerSessionState: new Map<string, ProviderSessionState>(),
					antigravityEndpointMode: "production",
					maxRetryDelayMs: 20,
				}),
			);

			expect(server.fetchCalls.map(call => call.endpoint)).toEqual([DAILY_ENDPOINT]);
			expect(server.exchanges.map(exchange => exchange.endpoint)).toEqual([DAILY_ENDPOINT]);
			expectEscalatedToSession(message);
			expect(settledAt - startedAt).toBeLessThan(RECOVERY_BOUND_MS);
			expect(await closedWithin(server.exchanges[0], RECOVERY_BOUND_MS)).toBe(true);
		} finally {
			await server.stop();
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"Gemini CLI single endpoint sends one request that never sends headers; the changed-prompt request opens a fresh connection",
	async () => {
		const warn = spyOnWarn();
		const server = startFakeCcaServer(async exchange => {
			if (server.exchanges.indexOf(exchange) === 0) return exchange.closed;
			respondWithText(exchange, "Recovered on the changed prompt.");
		});
		try {
			await server.warmPool();
			const options = {
				...watchdogOptions(server),
				providerSessionState: new Map<string, ProviderSessionState>(),
				maxRetryDelayMs: 20,
			};

			const startedAt = performance.now();
			const failed = await collect(streamGoogleGeminiCli(geminiCliModel, context, options));

			expectEscalatedToSession(failed.message);
			expect(failed.settledAt - startedAt).toBeLessThan(RECOVERY_BOUND_MS);
			expect(server.fetchCalls.map(call => call.endpoint)).toEqual([GEMINI_CLI_ENDPOINT]);
			const [stalled] = server.exchanges;
			expect(server.fetchCalls[0].signal?.aborted).toBe(true);
			expect(await closedWithin(stalled, RECOVERY_BOUND_MS)).toBe(true);
			expectTimeoutLogged(warn, GEMINI_CLI_ENDPOINT);

			// Session recovery appends a turn; that request avoids the pool that stalled.
			const changedPrompt: Context = {
				messages: [...context.messages, { role: "user", content: "Continue.", timestamp: 2 }],
			};
			const recovered = await collect(streamGoogleGeminiCli(geminiCliModel, changedPrompt, options));

			expect(recovered.message.errorMessage).toBeUndefined();
			expect(contentSummary(recovered.message)).toEqual([["text", "Recovered on the changed prompt."]]);
			expect(server.fetchCalls.map(call => call.endpoint)).toEqual([GEMINI_CLI_ENDPOINT, GEMINI_CLI_ENDPOINT]);
			expect(server.exchanges).toHaveLength(2);
			expectFreshConnection(server, stalled, server.exchanges[1], server.fetchCalls[1]);
		} finally {
			await server.stop();
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"a single endpoint still retries HTTP 503 and a connection closed before headers",
	async () => {
		spyOnWarn();
		const server = startFakeCcaServer(exchange => {
			const index = server.exchanges.indexOf(exchange);
			if (index === 0) exchange.sendStatus(503, '{"error":{"code":503,"message":"Service unavailable"}}');
			else if (index === 1) exchange.hangUp();
			else respondWithText(exchange, "Recovered after retries.");
		});
		try {
			const { message } = await collect(
				streamGoogleGeminiCli(antigravityModel, context, {
					...watchdogOptions(server),
					providerSessionState: new Map<string, ProviderSessionState>(),
					antigravityEndpointMode: "production",
					maxRetryDelayMs: 20,
				}),
			);

			expect(message.errorMessage).toBeUndefined();
			expect(contentSummary(message)).toEqual([["text", "Recovered after retries."]]);
			expect(server.fetchCalls.map(call => call.endpoint)).toEqual([DAILY_ENDPOINT, DAILY_ENDPOINT, DAILY_ENDPOINT]);
		} finally {
			await server.stop();
		}
	},
	TEST_TIMEOUT_MS,
);
