import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { getAntigravityProviderSessionState, streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const FIRST_BYTE_TIMEOUT_MS = 300_000;
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-4-carbon",
	name: "Gemini 4 Carbon (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

// This file exercises endpoint failover; pinning the client version keeps the
// manifest lookup off the injected fetch, which only models CCA endpoints.
const savedAntigravityVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
beforeEach(() => {
	process.env.PI_AI_ANTIGRAVITY_VERSION = "2.19.1";
});

afterEach(() => {
	vi.useRealTimers();
	if (savedAntigravityVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
	else process.env.PI_AI_ANTIGRAVITY_VERSION = savedAntigravityVersion;
});

function endpointFromInput(input: Parameters<FetchImpl>[0]): string {
	const url = input instanceof Request ? input.url : input.toString();
	return url.startsWith(ANTIGRAVITY_SANDBOX_ENDPOINT) ? ANTIGRAVITY_SANDBOX_ENDPOINT : ANTIGRAVITY_DAILY_ENDPOINT;
}

function responseWithUrl(response: Response, endpoint: string): Response {
	Object.defineProperty(response, "url", { value: `${endpoint}/v1internal:streamGenerateContent?alt=sse` });
	return response;
}

test("Antigravity Carbon tolerates 146-second silence and fails over at the first-byte deadline", async () => {
	const requestedEndpoints: string[] = [];
	const keepalive: Array<boolean | undefined> = [];
	let dailyAborted = false;
	const dailyBodyReadStarted = Promise.withResolvers<void>();
	vi.useFakeTimers();

	const fetchMock: FetchImpl = async (input, init) => {
		const endpoint = endpointFromInput(input);
		requestedEndpoints.push(endpoint);
		keepalive.push(init?.keepalive);
		if (endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT) {
			const body = `data: ${JSON.stringify({
				response: {
					candidates: [{ content: { parts: [{ text: "Recovered after stall." }] }, finishReason: "STOP" }],
				},
			})}\n\n`;
			return responseWithUrl(
				new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
				endpoint,
			);
		}

		init?.signal?.addEventListener("abort", () => {
			dailyAborted = true;
		});
		return responseWithUrl(
			new Response(
				new ReadableStream({
					pull() {
						dailyBodyReadStarted.resolve();
						return new Promise(() => {});
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
			endpoint,
		);
	};

	const stream = streamGoogleGeminiCli(antigravityModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "auto",
		fetch: fetchMock,
	});
	const resultPromise = stream.result();
	await dailyBodyReadStarted.promise;
	expect(vi.getTimerCount()).toBeGreaterThan(0);
	// A real high-thinking turn was silent for 146s; preserve that valid cold start.
	vi.advanceTimersByTime(146_000);
	expect(dailyAborted).toBe(false);
	vi.advanceTimersByTime(FIRST_BYTE_TIMEOUT_MS - 146_000);
	const result = await resultPromise;

	expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT]);
	expect(keepalive).toEqual([undefined, false]);
	expect(dailyAborted).toBe(true);
	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([{ type: "text", text: "Recovered after stall." }]);
});

const encoder = new TextEncoder();
const sse = (text: string, finishReason?: string): Uint8Array =>
	encoder.encode(
		`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text }] }, finishReason }] } })}\n\n`,
	);

/**
 * A body that writes `chunks` `gapMs` apart, then either ends or stalls forever.
 * Real time on purpose: the watchdog races actual chunk arrival through the SSE
 * reader, which fake timers cannot interleave.
 */
function slowBody(chunks: Uint8Array[], gapMs: number, stall: boolean): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async pull(controller) {
			const chunk = chunks.shift();
			if (chunk) {
				await Bun.sleep(gapMs);
				controller.enqueue(chunk);
			} else if (stall) {
				await new Promise(() => {});
			} else {
				controller.close();
			}
		},
	});
}

test("a stall after text fails the turn as incomplete without resending, and the next request opens a fresh connection", async () => {
	const requests: Array<{ endpoint: string; keepalive: boolean | undefined }> = [];
	const bodies = [slowBody([sse("partial answer")], 0, true), slowBody([sse("Recovered.", "STOP")], 0, false)];
	const fetchMock: FetchImpl = async (input, init) => {
		const endpoint = endpointFromInput(input);
		requests.push({ endpoint, keepalive: init?.keepalive });
		return responseWithUrl(new Response(bodies.shift(), { status: 200 }), endpoint);
	};
	const providerSessionState = new Map<string, ProviderSessionState>();
	const options = {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "auto" as const,
		fetch: fetchMock,
		providerSessionState,
		streamIdleTimeoutMs: 50,
	};

	const stalled = await streamGoogleGeminiCli(antigravityModel, context, options).result();
	expect(stalled.stopReason).toBe("error");
	expect(stalled.errorMessage).toStartWith("Cloud Code Assist API returned an incomplete response: stream silent");
	expect(requests).toEqual([{ endpoint: ANTIGRAVITY_DAILY_ENDPOINT, keepalive: undefined }]);
	expect(getAntigravityProviderSessionState(providerSessionState)?.freshConnection).toBe(true);

	const next = await streamGoogleGeminiCli(antigravityModel, context, options).result();
	expect(next.content).toEqual([{ type: "text", text: "Recovered." }]);
	expect(requests[1].keepalive).toBe(false);
	expect(getAntigravityProviderSessionState(providerSessionState)?.freshConnection).toBe(false);
});

test("raw bytes such as SSE comments keep a slow stream alive past the idle deadline", async () => {
	let requests = 0;
	const comments = Array.from({ length: 12 }, () => encoder.encode(": keepalive\n\n"));
	const fetchMock: FetchImpl = async input => {
		requests++;
		const endpoint = endpointFromInput(input);
		return responseWithUrl(
			new Response(slowBody([...comments, sse("Done.", "STOP")], 25, false), { status: 200 }),
			endpoint,
		);
	};
	const result = await streamGoogleGeminiCli(antigravityModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "auto",
		fetch: fetchMock,
		streamFirstEventTimeoutMs: 150,
		streamIdleTimeoutMs: 150,
	}).result();

	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([{ type: "text", text: "Done." }]);
	expect(requests).toBe(1);
});
