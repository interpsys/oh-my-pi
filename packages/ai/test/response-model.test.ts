/**
 * `AssistantMessage.responseModel` is the model id the provider RESPONSE
 * reported. Every fixture reports an id that differs from the requested
 * `model.id`, so a copy from the request fails the positive cases, and every
 * negative case omits the field so a request-id fallback fails there.
 * Retry cases pin that a discarded attempt's reported model never leaks onto
 * the turn another attempt produced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { consumeGoogleStream } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { GenerateContentResponse } from "@oh-my-pi/pi-ai/providers/google-types";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as piUtils from "@oh-my-pi/pi-utils";

const { getAgentDir, setAgentDir, TempDir } = piUtils;

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function sseResponse(events: unknown[], url?: string): Response {
	const response = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
	// Cloud Code Assist re-reads `response.url`; synthetic Responses default it to "".
	if (url) Object.defineProperty(response, "url", { value: url });
	return response;
}

const originalAgentDir = getAgentDir();

afterEach(() => {
	setAgentDir(originalAgentDir);
	vi.restoreAllMocks();
});

// ─── Anthropic: message_start.message.model ─────────────────────────────────

const anthropicModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
});
const ANTHROPIC_REPORTED = "claude-sonnet-5-20261001";

function anthropicRequest(events: Record<string, unknown>[]) {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

function anthropicMessageStart(reportedModel?: string): Record<string, unknown> {
	const message: Record<string, unknown> = { id: "msg_rm", usage: { input_tokens: 5, output_tokens: 0 } };
	if (reportedModel !== undefined) message.model = reportedModel;
	return { type: "message_start", message };
}

function anthropicTextEvents(reportedModel?: string): Record<string, unknown>[] {
	return [
		anthropicMessageStart(reportedModel),
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
}

async function runAnthropic(): Promise<AssistantMessage> {
	const s = streamAnthropic(anthropicModel, context, { apiKey: "sk-ant-test", providerRetryWait: async () => {} });
	for await (const _ of s) {
		// drain
	}
	return s.result();
}

describe("anthropic responseModel", () => {
	it("records message_start.message.model while model stays the requested id", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => anthropicRequest(anthropicTextEvents(ANTHROPIC_REPORTED)) as never,
		);
		const message = await runAnthropic();
		expect(message.stopReason).toBe("stop");
		expect(message.model).toBe("claude-sonnet-5");
		expect(message.responseModel).toBe(ANTHROPIC_REPORTED);
	});

	it("leaves responseModel undefined when message_start omits the model", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => anthropicRequest(anthropicTextEvents()) as never,
		);
		const message = await runAnthropic();
		expect(message.stopReason).toBe("stop");
		expect(message.model).toBe("claude-sonnet-5");
		expect(message.responseModel).toBeUndefined();
	});

	it("drops the model a cut, retried attempt reported", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			// Attempt 1 dies right after message_start: replay-safe, so the provider retries.
			return anthropicRequest(
				attempt === 1 ? [anthropicMessageStart(ANTHROPIC_REPORTED)] : anthropicTextEvents(),
			) as never;
		});
		const message = await runAnthropic();
		expect(attempt).toBe(2);
		expect(message.stopReason).toBe("stop");
		expect(message.responseModel).toBeUndefined();
	});
});

// ─── google-gemini-cli (Antigravity): response.modelVersion ─────────────────

const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SSE_URL = `${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;
const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: ANTIGRAVITY_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});
const GEMINI_REPORTED = "gemini-3-flash-preview-11-2026";

/** Top-level `GenerateContentResponse` shape (public Generative Language + Vertex). */
function genaiChunk(text: string, modelVersion?: string): Record<string, unknown> {
	const chunk: Record<string, unknown> = {
		candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: text ? 5 : 0, totalTokenCount: 15 },
	};
	if (modelVersion !== undefined) chunk.modelVersion = modelVersion;
	return chunk;
}

/** `{ response }` envelope (Cloud Code Assist: google-gemini-cli / antigravity). */
function ccaChunk(text: string, modelVersion?: string): Record<string, unknown> {
	return { response: genaiChunk(text, modelVersion) };
}

describe("google-gemini-cli (antigravity) responseModel", () => {
	// Pinning the client version keeps the Antigravity manifest lookup off the injected fetch.
	const savedAntigravityVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
	beforeEach(() => {
		process.env.PI_AI_ANTIGRAVITY_VERSION = "2.19.1";
	});
	afterEach(() => {
		if (savedAntigravityVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		else process.env.PI_AI_ANTIGRAVITY_VERSION = savedAntigravityVersion;
	});

	async function runAntigravity(responses: Array<Record<string, unknown>>) {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			const chunk = responses[Math.min(calls, responses.length - 1)];
			calls += 1;
			return sseResponse([chunk], ANTIGRAVITY_SSE_URL);
		};
		const result = await streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "production",
			fetch: fetchMock,
		}).result();
		return { result, calls };
	}

	it("records response.modelVersion while model stays the requested id", async () => {
		const { result } = await runAntigravity([ccaChunk("Done.", GEMINI_REPORTED)]);
		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe("gemini-3-flash");
		expect(result.responseModel).toBe(GEMINI_REPORTED);
	});

	it("leaves responseModel undefined when the response omits modelVersion", async () => {
		const { result } = await runAntigravity([ccaChunk("Done.")]);
		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe("gemini-3-flash");
		expect(result.responseModel).toBeUndefined();
	});

	it("drops the model an empty, retried attempt reported", async () => {
		const { result, calls } = await runAntigravity([ccaChunk("", GEMINI_REPORTED), ccaChunk("Done.")]);
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.responseModel).toBeUndefined();
	});
});

// ─── Google Generative AI / Vertex (consumeGoogleStream): modelVersion ──────

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

function emptyGenaiAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "google-generative-ai",
		provider: "google",
		model: genaiModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

async function consumeChunks(chunks: Record<string, unknown>[]): Promise<AssistantMessage> {
	const output = emptyGenaiAssistant();
	const stream = new AssistantMessageEventStream();
	const draining = (async () => {
		for await (const _ of stream) {
			// drain
		}
	})();
	async function* googleStream(): AsyncGenerator<GenerateContentResponse> {
		for (const chunk of chunks) yield chunk as unknown as GenerateContentResponse;
	}
	await consumeGoogleStream({ googleStream: googleStream(), output, stream, model: genaiModel, options: undefined });
	stream.end(output);
	await draining;
	return output;
}

describe("google-shared consumeGoogleStream responseModel", () => {
	it("records chunk.modelVersion while model stays the requested id", async () => {
		const output = await consumeChunks([genaiChunk("Hello", GEMINI_REPORTED)]);
		expect(output.model).toBe("gemini-3-flash");
		expect(output.responseModel).toBe(GEMINI_REPORTED);
	});

	it("leaves responseModel undefined when chunks omit modelVersion", async () => {
		const output = await consumeChunks([genaiChunk("Hello")]);
		expect(output.model).toBe("gemini-3-flash");
		expect(output.responseModel).toBeUndefined();
	});

	it("drops the model an empty, retried streamGoogle attempt reported", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sseResponse([calls === 1 ? genaiChunk("", GEMINI_REPORTED) : genaiChunk("Hello")]);
		};
		const result = await streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock }).result();
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.responseModel).toBeUndefined();
	});
});

// ─── openai-codex-responses: response.created / response.completed model ───

const codexModel: Model<"openai-codex-responses"> = {
	...buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 128_000,
	}),
	preferWebsockets: false,
};
const CODEX_REPORTED = "gpt-5.3-codex-spark-2026-10-01";

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function codexTextEvents(createdModel?: string, completedModel?: string): Record<string, unknown>[] {
	const created: Record<string, unknown> = { id: "resp_rm", status: "in_progress" };
	if (createdModel !== undefined) created.model = createdModel;
	const completed: Record<string, unknown> = {
		id: "resp_rm",
		status: "completed",
		usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
	};
	if (completedModel !== undefined) completed.model = completedModel;
	return [
		{ type: "response.created", response: created },
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_rm", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_rm",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		},
		{ type: "response.completed", response: completed },
	];
}

describe("openai-codex-responses responseModel", () => {
	beforeEach(() => {
		setAgentDir(TempDir.createSync("@pi-response-model-").path());
		vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
	});

	async function runCodex(attempts: Record<string, unknown>[][]) {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			const events = attempts[Math.min(calls, attempts.length - 1)];
			calls += 1;
			return sseResponse(events);
		};
		const result = await streamOpenAICodexResponses(codexModel, context, {
			apiKey: codexToken(),
			fetch: fetchMock,
		}).result();
		return { result, calls };
	}

	it.each([
		{ name: "response.created", created: CODEX_REPORTED, completed: undefined },
		{ name: "response.completed", created: undefined, completed: CODEX_REPORTED },
		{ name: "both lifecycle events", created: CODEX_REPORTED, completed: CODEX_REPORTED },
	])("records response.model from $name while model stays the requested id", async ({ created, completed }) => {
		const { result } = await runCodex([codexTextEvents(created, completed)]);
		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe("gpt-5.3-codex-spark");
		expect(result.responseModel).toBe(CODEX_REPORTED);
	});

	it("leaves responseModel undefined when no lifecycle event reports a model", async () => {
		const { result } = await runCodex([codexTextEvents()]);
		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe("gpt-5.3-codex-spark");
		expect(result.responseModel).toBeUndefined();
	});

	it("drops the model a truncated, retried attempt reported", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const truncated = [
			{ type: "response.created", response: { id: "resp_cut", status: "in_progress", model: CODEX_REPORTED } },
		];
		const { result, calls } = await runCodex([truncated, codexTextEvents()]);
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.responseModel).toBeUndefined();
	});
});

// ─── openai-responses: response.created / response.completed model ─────────

const responsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const RESPONSES_REPORTED = "gpt-5-mini-2025-08-07";

function responsesTextEvents(createdModel?: string, completedModel?: string): Record<string, unknown>[] {
	const created: Record<string, unknown> = { id: "resp_rm", status: "in_progress" };
	if (createdModel !== undefined) created.model = createdModel;
	const completed: Record<string, unknown> = { id: "resp_rm", status: "completed" };
	if (completedModel !== undefined) completed.model = completedModel;
	return [
		{ type: "response.created", response: created },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_rm", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: "msg_rm", delta: "Hello" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_rm",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		},
		{ type: "response.completed", response: completed },
	];
}

describe("openai-responses responseModel", () => {
	async function runResponses(attempts: Record<string, unknown>[][]) {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			const events = attempts[Math.min(calls, attempts.length - 1)];
			calls += 1;
			return sseResponse(events);
		};
		const result = await streamOpenAIResponses(responsesModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();
		return { result, calls };
	}

	it.each([
		{ name: "response.created", created: RESPONSES_REPORTED, completed: undefined },
		{ name: "response.completed", created: undefined, completed: RESPONSES_REPORTED },
	])("records response.model from $name while model stays the requested id", async ({ created, completed }) => {
		const { result } = await runResponses([responsesTextEvents(created, completed)]);
		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe(responsesModel.id);
		expect(result.responseModel).toBe(RESPONSES_REPORTED);
	});

	it("leaves responseModel undefined when no lifecycle event reports a model", async () => {
		const { result } = await runResponses([responsesTextEvents()]);
		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe(responsesModel.id);
		expect(result.responseModel).toBeUndefined();
	});

	it("drops the model a gateway-failed, retried attempt reported", async () => {
		const failed = [
			{ type: "response.created", response: { id: "resp_gw", status: "in_progress", model: RESPONSES_REPORTED } },
			{
				type: "error",
				error: {
					code: "stream_incomplete",
					message: "Upstream websocket closed before response.completed: Upstream websocket receive failed",
				},
			},
		];
		const { result, calls } = await runResponses([failed, responsesTextEvents()]);
		expect(calls).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.responseModel).toBeUndefined();
	});
});

// ─── openai-completions: chunk.model ────────────────────────────────────────

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;
const COMPLETIONS_REPORTED = "gpt-4o-mini-2024-07-18";

function completionsChunk(reportedModel: string | undefined, extra: Record<string, unknown>): Record<string, unknown> {
	const chunk: Record<string, unknown> = { id: "chatcmpl-rm", object: "chat.completion.chunk", created: 0, ...extra };
	if (reportedModel !== undefined) chunk.model = reportedModel;
	return chunk;
}

async function runCompletions(models: Array<string | undefined>): Promise<AssistantMessage> {
	const [first, second] = models;
	const payload = [
		completionsChunk(first, { choices: [{ index: 0, delta: { content: "Hi" } }] }),
		completionsChunk(second, {
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}),
	];
	const fetchMock: FetchImpl = async () =>
		new Response(`${payload.map(chunk => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	return streamOpenAICompletions(completionsModel, context, { apiKey: "test-key", fetch: fetchMock }).result();
}

describe("openai-completions responseModel", () => {
	it("records the first chunk.model while model stays the requested id", async () => {
		const result = await runCompletions([COMPLETIONS_REPORTED, "gpt-4o-mini-later"]);
		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe("gpt-4o-mini");
		expect(result.responseModel).toBe(COMPLETIONS_REPORTED);
	});

	it("takes the first non-empty chunk.model when early chunks carry an empty one", async () => {
		const result = await runCompletions(["", COMPLETIONS_REPORTED]);
		expect(result.responseModel).toBe(COMPLETIONS_REPORTED);
	});

	it("leaves responseModel undefined when no chunk carries a model", async () => {
		const result = await runCompletions([undefined, undefined]);
		expect(result.stopReason).toBe("stop");
		expect(result.model).toBe("gpt-4o-mini");
		expect(result.responseModel).toBeUndefined();
	});
});
