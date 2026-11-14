import { describe, expect, it } from "bun:test";
import { buildRequest, streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Content } from "@oh-my-pi/pi-ai/providers/google-types";
import type { AssistantMessage, Context, Model, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Stripping the signatures of turn-opening steps (an earlier 400 workaround) made
// Gemini 4 Carbon answer long sessions with signature-only empty streams; the
// official Antigravity client replays every real signature, and so does omp.

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const SENTINEL = "skip_thought_signature_validator";
const SIG_PROMPT = "UFJPTVBU";
const SIG_CLOCK = "Q0xPQ0s=";
const SIG_LOOP = "TE9PUA==";

function argon(): Model<"google-gemini-cli"> {
	const model = getBundledModel<"google-gemini-cli">("google-antigravity", "gemini-4-argon");
	if (!model) throw new Error("Expected bundled google-antigravity/gemini-4-argon");
	return model;
}

function geminiCli(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-3.7-flash",
		name: "gemini-3.7-flash",
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65536,
	});
}

function step(model: Model, content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp,
	};
}

function result(toolCallId: string, toolName: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp,
	};
}

/** Prompt → step → result → injected clock → step → result → step → result, as in the failing sessions. */
function session(model: Model): Context {
	return {
		messages: [
			{ role: "user", content: "Optimize the code", timestamp: 1 },
			step(
				model,
				[
					{ type: "thinking", thinking: "Read the file first." },
					{
						type: "toolCall",
						id: "call_1",
						name: "read",
						arguments: { path: "a.ts" },
						thoughtSignature: SIG_PROMPT,
					},
				],
				2,
			),
			result("call_1", "read", 3),
			{ role: "developer", content: "[now 2026-11-03 9:12:38 PM PST Tue · 2026-11-04 05:12Z]", timestamp: 4 },
			step(
				model,
				[{ type: "toolCall", id: "call_2", name: "eval", arguments: { code: "1" }, thoughtSignature: SIG_CLOCK }],
				5,
			),
			result("call_2", "eval", 6),
			step(
				model,
				[{ type: "toolCall", id: "call_3", name: "eval", arguments: { code: "2" }, thoughtSignature: SIG_LOOP }],
				7,
			),
			result("call_3", "eval", 8),
		],
	};
}

function modelSignatures(contents: readonly Content[]): Array<Array<string | undefined>> {
	return contents
		.filter(content => content.role === "model")
		.map(content => (content.parts ?? []).filter(part => part.functionCall).map(part => part.thoughtSignature));
}

// A real Gemini 4 Hydrogen reply: a signed call carrying a server id, then an empty
// STOP frame. Ids are redacted; the signature is redacted to base64("REDACTED").
const SIG_HYDROGEN = "UkVEQUNURUQ=";
const HYDROGEN_TOOL_CALL_SSE = [
	{
		candidates: [
			{
				content: {
					role: "model",
					parts: [
						{
							thoughtSignature: SIG_HYDROGEN,
							functionCall: { name: "echo", args: { value: 42 }, id: "call_5442528644386740970" },
						},
					],
				},
			},
		],
		usageMetadata: { promptTokenCount: 43, candidatesTokenCount: 13, totalTokenCount: 89, thoughtsTokenCount: 33 },
	},
	{
		candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 103, candidatesTokenCount: 19, totalTokenCount: 155, thoughtsTokenCount: 33 },
	},
]
	.map(response => ({
		response: { ...response, modelVersion: "gemini-4-hydrogen", responseId: "[REDACTED]" },
		traceId: "[REDACTED]",
		metadata: {},
	}))
	.map(frame => `data: ${JSON.stringify(frame)}\n\n`)
	.join("");

describe("Antigravity Gemini thought signatures", () => {
	it("replays every real signature, including steps that open a turn, like Gemini CLI", () => {
		const model = argon();
		const request = buildRequest(model, session(model), "project", {}, true);
		expect(modelSignatures(request.request.contents)).toEqual([[SIG_PROMPT], [SIG_CLOCK], [SIG_LOOP]]);
		expect(request.request.contents[1]?.parts?.[0]).toEqual({ thought: true, text: "Read the file first." });

		const cli = geminiCli();
		expect(modelSignatures(buildRequest(cli, session(cli), "project", {}, false).request.contents)).toEqual([
			[SIG_PROMPT],
			[SIG_CLOCK],
			[SIG_LOOP],
		]);
	});

	it("sends the validator sentinel only on an unsigned first call of a step", () => {
		const model = argon();
		const context: Context = {
			messages: [
				{ role: "user", content: "Search", timestamp: 1 },
				step(
					model,
					[
						{ type: "toolCall", id: "call_1", name: "grep", arguments: { pattern: "a" } },
						{ type: "toolCall", id: "call_2", name: "grep", arguments: { pattern: "b" } },
					],
					2,
				),
				result("call_1", "grep", 3),
				result("call_2", "grep", 4),
			],
		};

		expect(modelSignatures(buildRequest(model, context, "project", {}, true).request.contents)).toEqual([
			[SENTINEL, undefined],
		]);
	});

	it("parses a real Hydrogen tool call in one request and replays its signature next turn", async () => {
		const model = buildModel({
			id: "gemini-4-hydrogen",
			name: "Gemini 4 Hydrogen",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65536,
		});
		const context: Context = { messages: [{ role: "user", content: "Call echo with value 42.", timestamp: 1 }] };
		let fetches = 0;
		// Pinning the client version keeps the manifest lookup off the injected fetch.
		const savedVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
		process.env.PI_AI_ANTIGRAVITY_VERSION = "2.31.2";
		let generated: AssistantMessage;
		try {
			generated = await streamGoogleGeminiCli(model, context, {
				apiKey: JSON.stringify({ token: "token", projectId: "project" }),
				antigravityEndpointMode: "production",
				fetch: async () => {
					fetches++;
					return new Response(HYDROGEN_TOOL_CALL_SSE, { status: 200 });
				},
			}).result();
		} finally {
			if (savedVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
			else process.env.PI_AI_ANTIGRAVITY_VERSION = savedVersion;
		}

		expect(fetches).toBe(1);
		expect(generated.stopReason).toBe("toolUse");
		expect(generated.content).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: 42 }, thoughtSignature: SIG_HYDROGEN },
		]);
		const call = generated.content[0];
		if (call?.type !== "toolCall") throw new Error("expected a tool call");
		const next = buildRequest(
			model,
			{
				messages: [
					...context.messages,
					generated,
					result(call.id, call.name, 2),
					{ role: "user", content: "Reply with exactly 42.", timestamp: 3 },
				],
			},
			"project",
			{},
			true,
		);
		expect(modelSignatures(next.request.contents)).toEqual([[SIG_HYDROGEN]]);
	});
});
