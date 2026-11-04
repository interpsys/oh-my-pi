import { describe, expect, it } from "bun:test";
import { buildRequest } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { Content } from "@oh-my-pi/pi-ai/providers/google-types";
import type { AssistantMessage, Context, Model, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Antigravity's Gemini routes answered long post-compaction sessions with a bare
// `400 INVALID_ARGUMENT` while the request's current turn held a signed model
// step. Every captured failing body succeeded once the steps that open a turn
// (after user text or images, not after function responses alone) replayed
// unsigned; tool-loop steps keep their signatures.

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
const SIG_THOUGHT = "VEhPVUdIVA==";

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

describe("Antigravity Gemini turn-opening thought signatures", () => {
	it("replays steps after user text unsigned and keeps tool-loop signatures", () => {
		const model = argon();
		const request = buildRequest(model, session(model), "project", {}, true);

		expect(modelSignatures(request.request.contents)).toEqual([[SENTINEL], [SENTINEL], [SIG_LOOP]]);
		// The step's own thinking still replays in the thought slot.
		expect(request.request.contents[1]?.parts?.[0]).toEqual({ thought: true, text: "Read the file first." });
	});

	it("keeps the first-call sentinel contract for parallel opening steps", () => {
		const model = argon();
		const context: Context = {
			messages: [
				{ role: "user", content: "Search", timestamp: 1 },
				step(
					model,
					[
						{
							type: "toolCall",
							id: "call_1",
							name: "grep",
							arguments: { pattern: "a" },
							thoughtSignature: SIG_PROMPT,
						},
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

	it("drops a signature-only thought part of an opening step", () => {
		const model = argon();
		const context: Context = {
			messages: [
				{ role: "user", content: "Go", timestamp: 1 },
				step(
					model,
					[
						{ type: "thinking", thinking: "", thinkingSignature: SIG_THOUGHT },
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
			],
		};

		const modelContent = buildRequest(model, context, "project", {}, true).request.contents[1];
		expect(modelContent?.parts).toEqual([
			{ functionCall: { name: "read", args: { path: "a.ts" } }, thoughtSignature: SENTINEL },
		]);
	});

	it("leaves other Google transports' signatures untouched", () => {
		const cli = geminiCli();
		expect(modelSignatures(buildRequest(cli, session(cli), "project", {}, false).request.contents)).toEqual([
			[SIG_PROMPT],
			[SIG_CLOCK],
			[SIG_LOOP],
		]);

		const model = argon();
		expect(modelSignatures(convertMessages(model, session(model)))).toEqual([[SIG_PROMPT], [SIG_CLOCK], [SIG_LOOP]]);
	});
});
