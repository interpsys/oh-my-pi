import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { RAW_EMPTY_RESPONSE_MAX_EVENTS, stripRawHttpRequestDiagnostics } from "@oh-my-pi/pi-ai/utils/http-inspector";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// A Gemini turn that finishes with `finishReason: STOP` but carries only an empty text part —
// the well-known "empty response" failure. Delivered as-is, the agent receives a blank message
// and silently halts, so the provider must retry instead of surfacing it.

function sse(...chunks: unknown[]): Response {
	const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Top-level `candidates` shape (public Generative Language + Vertex). */
function genaiChunk(text: string): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: text ? 5 : 0, totalTokenCount: 15 },
	};
}

/** A Gemini finish the SDK's enum lacks: the backend failed to produce a response. */
function malformedResponseChunk(): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text: "Partial" }] }, finishReason: "MALFORMED_RESPONSE" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
	};
}

/** `{ response: { candidates } }` envelope (Cloud Code Assist: google-gemini-cli / antigravity). */
function ccaChunk(text: string): Record<string, unknown> {
	return { response: genaiChunk(text) };
}

/**
 * `{ response: { candidates } }` envelope carrying only a thinking part with `finishReason: STOP` —
 * the intentional-silence Advisor case (#8480): no visible text and no tool call.
 */
function ccaThinkingOnlyChunk(thinking: string): Record<string, unknown> {
	return {
		response: {
			candidates: [{ content: { parts: [{ text: thinking, thought: true }] }, finishReason: "STOP" }],
			usageMetadata: {
				promptTokenCount: 10,
				candidatesTokenCount: 0,
				thoughtsTokenCount: 5,
				totalTokenCount: 15,
			},
		},
	};
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, starts: events.filter(e => e.type === "start").length };
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter(b => b.type === "text")
		.map(b => b.text ?? "")
		.join("");
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const genaiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const vertexModel: Model<"google-vertex"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Vertex)",
	api: "google-vertex",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CCA)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	...cliModel,
	provider: "google-antigravity",
	baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
});

function withResponseUrl(response: Response, endpoint: string): Response {
	Object.defineProperty(response, "url", { value: `${endpoint}/v1internal:streamGenerateContent?alt=sse` });
	return response;
}

function endpointFromInput(input: Parameters<FetchImpl>[0]): string {
	const url = input instanceof Request ? input.url : input.toString();
	return url.startsWith(ANTIGRAVITY_SANDBOX_ENDPOINT) ? ANTIGRAVITY_SANDBOX_ENDPOINT : ANTIGRAVITY_DAILY_ENDPOINT;
}

describe("Google empty-response retry (public + Vertex path)", () => {
	it("retries a STOP-with-empty-text response and delivers the real follow-up content", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return calls === 1 ? sse(genaiChunk("")) : sse(genaiChunk("Hello!"));
		};

		const stream = streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock });
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2); // one empty attempt + one successful retry
		expect(starts).toBe(1); // exactly one start across the retry — no duplicate partials
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Hello!");
		void events;
	});

	it("surfaces an error after exhausting retries when every attempt is empty", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sse(genaiChunk(""));
		};

		const stream = streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock });
		const result = await stream.result();

		expect(calls).toBe(3); // MAX_EMPTY_STREAM_RETRIES (2) + 1 initial attempt
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("empty response");
	});

	it("ends a MALFORMED_RESPONSE finish as a transient error that keeps the turn's usage", async () => {
		const fetchMock: FetchImpl = async () => sse(malformedResponseChunk());

		const result = await streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock }).result();

		expect(result.stopReason).toBe("error");
		expect(result.usage.input).toBe(10);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});

	it("accepts an empty STOP when silence is a valid caller result", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sse(genaiChunk(""));
		};

		const stream = streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch: fetchMock,
			acceptEmptyResponse: true,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("filters out empty text parts at stream end but preserves terminal thought signatures", async () => {
		const chunks = [
			{ candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
			{
				candidates: [
					{ content: { parts: [{ text: "", thoughtSignature: "terminal-sig" }] }, finishReason: "STOP" },
				],
			},
		];

		const fetchMock: FetchImpl = async input => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("oauth2.googleapis.com/token") || url.includes("metadata.google.internal")) {
				return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
			}
			return sse(...chunks);
		};

		const stream = streamGoogleVertex(vertexModel, context, {
			project: "project",
			location: "location",
			fetch: fetchMock,
		});
		const { events } = await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Hello",
			textSignature: "terminal-sig",
		});

		const textStartEvents = events.filter(e => e.type === "text_start");
		expect(textStartEvents).toHaveLength(1);
		expect(textStartEvents[0].contentIndex).toBe(0);

		const textDeltaEvents = events.filter(e => e.type === "text_delta");
		expect(textDeltaEvents).toHaveLength(1);
		expect(textDeltaEvents[0].delta).toBe("Hello");

		const textEndEvents = events.filter(e => e.type === "text_end");
		expect(textEndEvents).toHaveLength(1);
		expect(textEndEvents[0].content).toBe("Hello");
	});

	it("does not coalesce function-call thought signatures into the preceding Vertex text block", async () => {
		const chunks = [
			{ candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: { name: "lookup", args: { q: "x" }, id: "call_1" },
									thoughtSignature: "function-call-sig",
								},
							],
						},
						finishReason: "STOP",
					},
				],
			},
		];

		const fetchMock: FetchImpl = async input => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("oauth2.googleapis.com/token") || url.includes("metadata.google.internal")) {
				return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
			}
			return sse(...chunks);
		};

		const stream = streamGoogleVertex(vertexModel, context, {
			project: "project",
			location: "location",
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: "Hello" });
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "lookup",
			arguments: { q: "x" },
			thoughtSignature: "function-call-sig",
		});
	});
});

describe("Google empty-response retry (Cloud Code Assist path)", () => {
	// Endpoint-counting mocks model CCA only; pinning the client version keeps
	// the Antigravity manifest lookup off the injected fetch.
	const savedAntigravityVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
	beforeEach(() => {
		process.env.PI_AI_ANTIGRAVITY_VERSION = "2.19.1";
	});
	afterEach(() => {
		if (savedAntigravityVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		else process.env.PI_AI_ANTIGRAVITY_VERSION = savedAntigravityVersion;
	});

	it("retries a STOP-with-empty-text response (the reported gemini-3-flash hang)", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			// Cloud Code Assist re-fetches `response.url` on retry; synthetic Responses default it to "".
			const response = calls === 1 ? sse(ccaChunk("")) : sse(ccaChunk("Done."));
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2);
		expect(starts).toBe(1); // the empty attempt must not leave a dangling duplicate start
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Done.");
		void events;
	});

	it("classifies a MALFORMED_RESPONSE finish as transient, as on the public path", async () => {
		const fetchMock: FetchImpl = async () => {
			const response = sse({ response: malformedResponseChunk() });
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const result = await streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});

	it("surfaces thought-only STOP immediately for session-level final-output recovery", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			const response = sse(ccaThinkingOnlyChunk("The task is complete, but I omitted the final answer."));
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("thought-only response without final output");
		expect(AIError.is(result.errorId, AIError.Flag.EmptyResponse)).toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "thinking",
				thinking: "The task is complete, but I omitted the final answer.",
			}),
		]);
	});

	it.each([undefined, "STOP"])("does not restart exhausted empty retries (finishReason=%s)", async finishReason => {
		let calls = 0;
		const usageMetadata = { promptTokenCount: 146282, candidatesTokenCount: 0, totalTokenCount: 146282 };
		const fetchMock: FetchImpl = async () => {
			calls++;
			return withResponseUrl(
				sse({
					response: {
						candidates: finishReason ? [{ content: { role: "model", parts: [] }, finishReason }] : [],
						usageMetadata,
					},
				}),
				"https://example.com",
			);
		};
		const result = await streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		}).result();

		expect(calls).toBe(3);
		expect(result.stopReason).toBe("error");
		expect(AIError.retriable(result.errorId ?? 0)).toBe(false);
		expect(result.errorMessage).toContain("empty response");
		expect(result.errorMessage).toContain(`"finishReason":${JSON.stringify(finishReason ?? null)}`);
		expect(result.errorMessage).toContain(`"usageMetadata":${JSON.stringify(usageMetadata)}`);
		expect(result.errorMessage).toContain('"promptFeedback":null');
	});

	it("accepts an empty STOP when silence is a valid caller result", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sse(ccaChunk(""));
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
			acceptEmptyResponse: true,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("retries a stripped planning leak when empty STOPs are accepted", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			const response =
				calls === 1
					? sse(ccaChunk('{\n  "thought": "inspect the project",\n  "call": "lookup"\n}'))
					: sse({
							response: {
								candidates: [
									{
										content: {
											parts: [{ functionCall: { name: "lookup", args: { q: "x" }, id: "call_1" } }],
										},
										finishReason: "STOP",
									},
								],
							},
						});
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
			acceptEmptyResponse: true,
		});
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2);
		expect(starts).toBe(1);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "lookup",
			arguments: { q: "x" },
		});
		expect(events.filter(e => e.type === "toolcall_start")).toHaveLength(1);
	});

	it("fails over to the sandbox endpoint after daily returns only empty successful streams", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			const response = endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT ? sse(ccaChunk("Recovered.")) : sse(ccaChunk(""));
			return withResponseUrl(response, endpoint);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		});
		const { starts } = await drain(stream);
		const result = await stream.result();

		expect(requestedEndpoints).toEqual([
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_SANDBOX_ENDPOINT,
		]);
		expect(starts).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Recovered.");
	});

	it("exhausts Antigravity auto failover before accepting silence", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			return withResponseUrl(sse(ccaChunk("")), endpoint);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			acceptEmptyResponse: true,
			fetch: fetchMock,
		});
		const result = await stream.result();

		// Daily still burns its empty-response budget and fails over; only the
		// last (sandbox) endpoint records the empty STOP as valid silence.
		expect(requestedEndpoints).toEqual([
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_DAILY_ENDPOINT,
			ANTIGRAVITY_SANDBOX_ENDPOINT,
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("accepts Advisor silence without failover after thought events start", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			const response =
				endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT
					? sse(ccaChunk("Recovered."))
					: sse(ccaThinkingOnlyChunk("No concrete risk. I will stay silent."));
			return withResponseUrl(response, endpoint);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			acceptEmptyResponse: true,
			fetch: fetchMock,
		});
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
		expect(starts).toBe(1);
		expect(events.filter(event => event.type === "thinking_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "thinking_delta")).toHaveLength(1);
		expect(events.filter(event => event.type === "thinking_end")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(textOf(result)).toBe("");
	});

	it("does not fail over a thought-only error after stream events start", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			const response =
				endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT
					? sse(ccaChunk("Recovered."))
					: sse(ccaThinkingOnlyChunk("I reasoned but omitted the final answer."));
			return withResponseUrl(response, endpoint);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		});
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
		expect(starts).toBe(1);
		expect(events.filter(event => event.type === "thinking_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "thinking_delta")).toHaveLength(1);
		expect(events.filter(event => event.type === "thinking_end")).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("thought-only response without final output");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "thinking",
				thinking: "I reasoned but omitted the final answer.",
			}),
		]);
	});

	for (const { mode, endpoint } of [
		{ mode: "production", endpoint: ANTIGRAVITY_DAILY_ENDPOINT },
		{ mode: "sandbox", endpoint: ANTIGRAVITY_SANDBOX_ENDPOINT },
	] as const) {
		it(`keeps empty-response retries on the selected ${mode} endpoint`, async () => {
			const requestedEndpoints: string[] = [];
			const fetchMock: FetchImpl = async input => {
				const requestedEndpoint = endpointFromInput(input);
				requestedEndpoints.push(requestedEndpoint);
				return withResponseUrl(sse(ccaChunk("")), requestedEndpoint);
			};

			const stream = streamGoogleGeminiCli(antigravityModel, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				antigravityEndpointMode: mode,
				fetch: fetchMock,
			});
			const result = await stream.result();

			expect(requestedEndpoints).toEqual([endpoint, endpoint, endpoint]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("empty response");
		});
	}

	for (const { name, chunk, errorText } of [
		{
			name: "SAFETY finish",
			chunk: { response: { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] } },
			errorText: "SAFETY",
		},
		{
			name: "MALFORMED_FUNCTION_CALL finish",
			chunk: {
				response: { candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] },
			},
			errorText: "MALFORMED_FUNCTION_CALL",
		},
		{
			name: "PROHIBITED_CONTENT block",
			chunk: {
				response: {
					candidates: [],
					promptFeedback: { blockReason: "PROHIBITED_CONTENT", blockReasonMessage: "policy blocked" },
				},
			},
			errorText: "PROHIBITED_CONTENT",
		},
	] as const) {
		it(`does not fail over after a terminal ${name}`, async () => {
			const requestedEndpoints: string[] = [];
			const fetchMock: FetchImpl = async input => {
				const endpoint = endpointFromInput(input);
				requestedEndpoints.push(endpoint);
				return withResponseUrl(sse(chunk), endpoint);
			};

			const stream = streamGoogleGeminiCli(antigravityModel, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				antigravityEndpointMode: "auto",
				fetch: fetchMock,
			});
			const result = await stream.result();

			expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(errorText);
		});
	}

	it("does not fail over after an account-verification HTTP 403", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			return new Response(
				JSON.stringify({
					error: {
						code: 403,
						status: "PERMISSION_DENIED",
						details: [
							{
								"@type": "type.googleapis.com/google.rpc.ErrorInfo",
								reason: "VALIDATION_REQUIRED",
								metadata: { validation_url: "https://accounts.google.com/verify" },
							},
						],
					},
				}),
				{ status: 403 },
			);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Account verification required");
	});

	it("does not fail over after partial output has started", async () => {
		const requestedEndpoints: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const endpoint = endpointFromInput(input);
			requestedEndpoints.push(endpoint);
			return withResponseUrl(
				sse({ response: { candidates: [{ content: { parts: [{ text: "partial" }] } }] } }),
				endpoint,
			);
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "auto",
			fetch: fetchMock,
		});
		const { starts } = await drain(stream);
		const result = await stream.result();

		expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
		expect(starts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(textOf(result)).toBe("partial");
	});

	it("does not coalesce function-call thought signatures into the preceding text block", async () => {
		const chunks = [
			{ response: { candidates: [{ content: { parts: [{ text: "Done" }] } }] } },
			{
				response: {
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: { name: "lookup", args: { q: "x" }, id: "call_1" },
										thoughtSignature: "function-call-sig",
									},
								],
							},
							finishReason: "STOP",
						},
					],
				},
			},
		];

		const fetchMock: FetchImpl = async () => {
			const response = sse(...chunks);
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: "Done" });
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "lookup",
			arguments: { q: "x" },
			thoughtSignature: "function-call-sig",
		});
	});

	it("does not retry if finishReason is SAFETY and bubbles up the error", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			const response = sse({
				response: {
					candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
				},
			});
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});

		await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Generation failed with finish reason: SAFETY");
		expect(calls).toBe(1);
	});

	describe("raw empty-response diagnostic dump", () => {
		const roots: string[] = [];
		afterEach(async () => {
			await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
		});

		it.each(["", "Done"])("parses each wire frame once while capturing diagnostics (%s)", async text => {
			const raw = JSON.stringify(ccaChunk(text));
			const parse = spyOn(JSON, "parse");
			let fetches = 0;
			try {
				await streamGoogleGeminiCli(cliModel, context, {
					apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
					fetch: async () => {
						fetches++;
						return withResponseUrl(
							new Response(`data: ${raw}\n\n`, { headers: { "content-type": "text/event-stream" } }),
							"https://example.com",
						);
					},
				}).result();
				expect(fetches).toBe(text ? 1 : 3);
				expect(parse.mock.calls.filter(([input]) => input === raw)).toHaveLength(fetches);
			} finally {
				parse.mockRestore();
			}
		});

		it.each([undefined, "STOP"] as const)(
			"persists raw SSE events and unknown metadata after retries exhaust (finishReason=%s)",
			async finishReason => {
				const dumpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cca-empty-"));
				roots.push(dumpDir);
				const rawFixture = {
					response: {
						candidates: finishReason
							? [{ content: { role: "model", parts: [] }, finishReason, groundingMetadata: { step: 7 } }]
							: [],
						usageMetadata: { promptTokenCount: 146282, candidatesTokenCount: 0, totalTokenCount: 146282 },
						modelVersion: "gemini-4-argon-001",
						responseId: "resp_empty_99",
						unclassifiedBackendDetail: { zeroOutputReason: "BACKEND_SILENT_DROP", retryableHint: false },
					},
					traceId: "trace-xyz-123",
					vendorEnvelopeExtra: { region: "us-central1" },
				};

				const fetchMock: FetchImpl = async input => {
					const endpoint = endpointFromInput(input);
					const res = new Response(`event: message\ndata: ${JSON.stringify(rawFixture)}\n\n`, {
						status: 200,
						headers: {
							"content-type": "text/event-stream",
							"x-goog-api-key": "should-be-redacted",
						},
					});
					return withResponseUrl(res, endpoint);
				};

				const result = await streamGoogleGeminiCli(antigravityModel, context, {
					apiKey: JSON.stringify({ token: "secret-oauth-token-xyz", projectId: "proj-123" }),
					antigravityEndpointMode: "auto",
					emptyResponseDumpDir: dumpDir,
					fetch: fetchMock,
				}).result();

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain("Cloud Code Assist API returned an empty response:");
				expect(result.errorMessage).toContain(`\nraw-empty-response=${dumpDir}/`);
				expect(stripRawHttpRequestDiagnostics(result.errorMessage!)).not.toContain("raw-empty-response=");

				const files = (await fs.readdir(dumpDir)).filter(f => f.endsWith(".json"));
				expect(files).toHaveLength(1);
				const dumpPath = path.join(dumpDir, files[0]);
				const rawText = await fs.readFile(dumpPath, "utf8");
				expect(rawText).not.toContain("secret-oauth-token-xyz");
				expect(rawText).not.toContain("should-be-redacted");

				const parsed = JSON.parse(rawText);
				expect(parsed.provider).toBe("google-antigravity");
				expect(parsed.api).toBe("google-gemini-cli");
				expect(parsed.model).toBe(antigravityModel.id);
				expect(parsed.endpoint).toBe(ANTIGRAVITY_SANDBOX_ENDPOINT);
				expect(parsed.status).toBe(200);
				expect(parsed.headers["x-goog-api-key"]).toBe("[redacted]");
				expect(parsed.body).toBeUndefined();
				expect(parsed.events).toHaveLength(1);
				expect(parsed.events[0].parsed).toEqual(rawFixture);
				expect(parsed.chunks).toEqual([rawFixture]);
			},
		);

		it("does not write an empty-response dump on normal text, tool-call, thought-only, or accepted-silence responses", async () => {
			const dumpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cca-no-dump-"));
			roots.push(dumpDir);

			// 1. Normal text output
			const textRes = await streamGoogleGeminiCli(cliModel, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				emptyResponseDumpDir: dumpDir,
				fetch: async () => withResponseUrl(sse(ccaChunk("Hello world")), "https://example.com"),
			}).result();
			expect(textRes.stopReason).toBe("stop");

			// 2. Normal tool-call output
			const toolRes = await streamGoogleGeminiCli(cliModel, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				emptyResponseDumpDir: dumpDir,
				fetch: async () =>
					withResponseUrl(
						sse({
							response: {
								candidates: [
									{
										content: {
											parts: [{ functionCall: { name: "lookup", args: { q: "x" }, id: "call_1" } }],
										},
										finishReason: "STOP",
									},
								],
							},
						}),
						"https://example.com",
					),
			}).result();
			expect(toolRes.stopReason).toBe("toolUse");

			// 3. Explicit accepted silence
			const silentRes = await streamGoogleGeminiCli(cliModel, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				acceptEmptyResponse: true,
				emptyResponseDumpDir: dumpDir,
				fetch: async () => withResponseUrl(sse(ccaChunk("")), "https://example.com"),
			}).result();
			expect(silentRes.stopReason).toBe("stop");

			// 4. Thought-only response (not a silent zero-output stream)
			const thoughtRes = await streamGoogleGeminiCli(cliModel, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				emptyResponseDumpDir: dumpDir,
				fetch: async () =>
					withResponseUrl(sse(ccaThinkingOnlyChunk("Thinking without final text")), "https://example.com"),
			}).result();
			expect(thoughtRes.stopReason).toBe("error");
			expect(thoughtRes.errorMessage).not.toContain("raw-empty-response=");

			expect(await fs.readdir(dumpDir)).toEqual([]);
		});

		it("marks truncation explicitly when an empty stream exceeds the event cap and preserves provider error on write failure", async () => {
			const dumpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cca-trunc-"));
			roots.push(dumpDir);
			const manyEmptyFrames = Array.from({ length: RAW_EMPTY_RESPONSE_MAX_EVENTS + 5 }, (_, idx) => ({
				response: {
					candidates:
						idx === RAW_EMPTY_RESPONSE_MAX_EVENTS + 4 ? [{ content: { parts: [] }, finishReason: "STOP" }] : [],
					seq: idx,
				},
			}));

			const truncRes = await streamGoogleGeminiCli(cliModel, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				emptyResponseDumpDir: dumpDir,
				fetch: async () => withResponseUrl(sse(...manyEmptyFrames), "https://example.com"),
			}).result();
			expect(truncRes.stopReason).toBe("error");
			const files = await fs.readdir(dumpDir);
			expect(files).toHaveLength(1);
			const saved = JSON.parse(await fs.readFile(path.join(dumpDir, files[0]), "utf8"));
			expect(saved.truncated).toBe(true);
			expect(saved.omittedEvents).toBe(5);
			expect(saved.events).toHaveLength(RAW_EMPTY_RESPONSE_MAX_EVENTS);

			// Write failure control: target is a regular file, not a directory
			const badTarget = path.join(dumpDir, "not-a-dir");
			await fs.writeFile(badTarget, "block");
			const failRes = await streamGoogleGeminiCli(cliModel, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				emptyResponseDumpDir: badTarget,
				fetch: async () => withResponseUrl(sse(ccaChunk("")), "https://example.com"),
			}).result();
			expect(failRes.stopReason).toBe("error");
			expect(failRes.errorMessage).toContain("Cloud Code Assist API returned an empty response:");
			expect(failRes.errorMessage).toContain("\nraw-empty-response-save-failed=");
		});

		it("captures raw SSE payload over a real local HTTP server when an empty stream exhausts retries", async () => {
			const dumpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cca-http-live-"));
			roots.push(dumpDir);
			const liveFixture = {
				response: {
					candidates: [],
					usageMetadata: { promptTokenCount: 146282, candidatesTokenCount: 0, totalTokenCount: 146282 },
					modelVersion: "gemini-4-argon",
					responseId: "resp_live_http_empty",
					unclassifiedDiagnostics: { reason: "ZERO_CANDIDATES_HTTP_200", backendNode: "cca-edge-04" },
				},
				rawTopLevelField: "preserved-over-wire",
			};
			let serverHits = 0;
			const server = Bun.serve({
				port: 0,
				fetch(req) {
					serverHits += 1;
					const url = new URL(req.url);
					expect(url.pathname).toBe("/v1internal:streamGenerateContent");
					return new Response(`event: message\ndata: ${JSON.stringify(liveFixture)}\n\n`, {
						status: 200,
						headers: {
							"content-type": "text/event-stream",
							"x-goog-api-key": "live-server-secret",
						},
					});
				},
			});
			try {
				const baseOrigin = `http://127.0.0.1:${server.port}`;
				const res = await streamGoogleGeminiCli(antigravityModel, context, {
					apiKey: JSON.stringify({ token: "live-bearer-secret", projectId: "proj-live" }),
					antigravityEndpointMode: "production",
					emptyResponseDumpDir: dumpDir,
					fetch: (input, init) => {
						const target = String(input).replace(ANTIGRAVITY_DAILY_ENDPOINT, baseOrigin);
						return fetch(target, init);
					},
				}).result();

				expect(serverHits).toBe(3);
				expect(res.stopReason).toBe("error");
				expect(res.errorMessage).toContain(`\nraw-empty-response=${dumpDir}/`);
				const files = await fs.readdir(dumpDir);
				expect(files).toHaveLength(1);
				const saved = JSON.parse(await fs.readFile(path.join(dumpDir, files[0]), "utf8"));
				expect(saved.provider).toBe("google-antigravity");
				expect(saved.model).toBe(antigravityModel.id);
				expect(saved.headers["x-goog-api-key"]).toBe("[redacted]");
				expect(saved.events[0].parsed).toEqual(liveFixture);
			} finally {
				server.stop(true);
			}
		});
	});
});
