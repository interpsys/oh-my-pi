import { describe, expect, it } from "bun:test";
import {
	buildRequest,
	type GoogleGeminiCliOptions,
	getAntigravityProviderSessionState,
} from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Content } from "@oh-my-pi/pi-ai/providers/google-types";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderSessionState,
	TJsonSchema,
	Tool,
	ToolCall,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { normalizeSchemaForAntigravityGemini } from "@oh-my-pi/pi-ai/utils/schema";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import plainTurn from "./fixtures/antigravity-official-2.31.2/01-plain.json" with { type: "json" };
import toolCallTurn from "./fixtures/antigravity-official-2.31.2/03-tool-call.json" with { type: "json" };
import toolResultTurn from "./fixtures/antigravity-official-2.31.2/05-tool-result.json" with { type: "json" };
import followUpTurn from "./fixtures/antigravity-official-2.31.2/07-follow-up.json" with { type: "json" };

// The fixtures are the four request bodies the official Antigravity 2.31.2
// client (byte-identical language_server, Gemini 4 Carbon High) sent in one
// conversation: plain turn, tool call, tool result, follow-up. Source:
// /Users/compoooter/tmp/workers/wire-capture-official/official-request-0{2,3,4,1}.json.
// Redaction replaced only text: the system prompt and tool/property
// descriptions with `<path>` placeholders, the capture workspace path with
// `/workspace`, the project with `<project>`, and each real thought signature
// with one base64-alphabet placeholder used consistently across bodies.
// Structure, roles, ids, enums, bounds and request envelopes are as captured.

type Body = Record<string, unknown>;

interface OfficialBody {
	request: {
		contents: Content[];
		systemInstruction: { parts: Array<{ text: string }> };
		tools: Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> }>;
	};
}

const followUp = followUpTurn as unknown as OfficialBody;
const OFFICIAL_BODIES: Array<{ step: number; body: Body }> = [
	{ step: 1, body: plainTurn },
	{ step: 3, body: toolCallTurn },
	{ step: 5, body: toolResultTurn },
	{ step: 7, body: followUpTurn },
];

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const SENTINEL = "skip_thought_signature_validator";
const SIG_PLAIN = "SigPlainTurnText";
const SIG_CALL = "SigReadFileCall1";
const SIG_ANSWER = "SigToolAnswerTxt";
const CALL_ID = "call_5357696484820081180";
const FILE_PATH = "/workspace/conversation/wire-fixture.txt";
// official-response-03.json streamed this summary as a `thought` part before the
// signed call; omp stores it as an unsigned thinking block. The official client
// did not replay it.
const CALL_THOUGHT_SUMMARY =
	"Attempting to read the specified file. The goal is to extract and return its single line content precisely. No modifications to files or execution of commands are permitted, just a direct file read and response.\n\n\n";
const userText = (index: number): string => followUp.request.contents[index]?.parts?.[0]?.text ?? "";
const TOOL_OUTPUT = String(followUp.request.contents[4]?.parts?.[0]?.functionResponse?.response.output);

const INT64_BOUNDS: Record<string, true> = { minLength: true, maxLength: true, minItems: true, maxItems: true };

/** The official proto schema as an omp tool declares it: JSON Schema types and numeric bounds. */
function toJsonSchema(node: unknown): unknown {
	if (!node || typeof node !== "object" || Array.isArray(node)) return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "type" && typeof value === "string") out.type = value.toLowerCase();
		else if (Object.hasOwn(INT64_BOUNDS, key) && typeof value === "string") out[key] = Number(value);
		else if (key === "items") out.items = toJsonSchema(value);
		else if (key === "properties" && value && typeof value === "object") {
			out.properties = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, toJsonSchema(sub)]));
		} else out[key] = value;
	}
	return out;
}

const OFFICIAL_TOOLS: Tool[] = followUp.request.tools.map(({ functionDeclarations: [declaration] }) => ({
	name: declaration.name,
	description: declaration.description,
	parameters: toJsonSchema(declaration.parameters) as TJsonSchema,
}));

function carbon(): Model<"google-gemini-cli"> {
	const model = getBundledModel<"google-gemini-cli">("google-antigravity", "gemini-4-carbon");
	if (!model) throw new Error("Expected bundled google-antigravity/gemini-4-carbon");
	return model;
}

function antigravityClaude(): Model<"google-gemini-cli"> {
	const model = getBundledModel<"google-gemini-cli">("google-antigravity", "claude-sonnet-4-6");
	if (!model) throw new Error("Expected bundled google-antigravity/claude-sonnet-4-6");
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

/** Hydrogen High as Antigravity discovery materializes it (absent from the bundled catalog): Gemini class, M525/HIGH/262144 profile. */
function hydrogenHigh(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-4-hydrogen-high",
		name: "Gemini 4 Hydrogen (High)",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 262144,
		antigravityWireProfiles: {
			"gemini-4-hydrogen-high": {
				modelEnum: "MODEL_PLACEHOLDER_M525",
				maxOutputTokens: 262144,
				thinkingLevel: "HIGH",
			},
		},
	});
}

function step(
	model: Model,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		usage: ZERO_USAGE,
		stopReason,
		timestamp,
	};
}

/** The captured conversation as omp's stream parser stores it (thought summary unsigned, signatures on the parts they rode). */
function conversation(model: Model): Message[] {
	return [
		{ role: "user", content: userText(0), timestamp: 1 },
		step(model, [{ type: "text", text: "PLAIN_CAPTURE_OK", textSignature: SIG_PLAIN }], "stop", 2),
		{ role: "user", content: userText(2), timestamp: 3 },
		step(
			model,
			[
				{ type: "thinking", thinking: CALL_THOUGHT_SUMMARY },
				{
					type: "toolCall",
					id: CALL_ID,
					name: "read_file",
					arguments: { Path: FILE_PATH },
					thoughtSignature: SIG_CALL,
				},
			],
			"toolUse",
			4,
		),
		{
			role: "toolResult",
			toolCallId: CALL_ID,
			toolName: "read_file",
			content: [{ type: "text", text: TOOL_OUTPUT }],
			isError: false,
			timestamp: 5,
		},
		step(model, [{ type: "text", text: "wire_capture_tool_result_4827", textSignature: SIG_ANSWER }], "stop", 6),
		{ role: "user", content: userText(6), timestamp: 7 },
	];
}

function contextAt(model: Model, stepIndex: number): Context {
	return {
		systemPrompt: followUp.request.systemInstruction.parts.map(part => part.text),
		messages: conversation(model).slice(0, stepIndex),
		tools: OFFICIAL_TOOLS,
	};
}

/** The wire JSON of an omp request body. */
function wire(request: object): Body {
	return JSON.parse(JSON.stringify(request)) as Body;
}

/** Thought signatures of every model-role call and text part, per model content. */
function modelSignatures(contents: readonly Content[]): Array<Array<string | undefined>> {
	return contents
		.filter(content => content.role === "model" && !content.parts?.some(part => part.functionResponse))
		.map(content => (content.parts ?? []).map(part => part.thoughtSignature));
}

/**
 * Replace the per-conversation identity (session, agent, trajectory, execution
 * ids, request timestamp) after checking the lineage that ties them together;
 * steps, request ordinals and every other leaf stay as sent.
 */
function normalizeEnvelope(body: Body): Body {
	const requestId = body.requestId as string;
	const request = body.request as Body;
	const labels = request.labels as Record<string, string>;
	const [kind, agentId, timestamp, trajectoryId, stepIndex] = requestId.split("/");
	expect(timestamp).toMatch(/^\d+$/);
	expect(labels.cascade_id).toBe(agentId);
	expect(labels.root_cascade_id).toBe(agentId);
	expect(labels.trajectory_id).toBe(trajectoryId);
	expect(labels.request_id.startsWith(`${trajectoryId}-`)).toBe(true);
	return {
		...body,
		requestId: `${kind}/<agent>/<ms>/<trajectory>/${stepIndex}`,
		request: {
			...request,
			sessionId: "<session>",
			labels: {
				...labels,
				cascade_id: "<agent>",
				root_cascade_id: "<agent>",
				trajectory_id: "<trajectory>",
				request_id: labels.request_id.replace(trajectoryId, "<trajectory>"),
				...(labels.last_execution_id !== undefined && { last_execution_id: "<execution>" }),
			},
		},
	};
}

/** Build the four captured steps through one provider session, as one omp conversation does. */
function buildConversation(options: GoogleGeminiCliOptions): Body[] {
	const model = carbon();
	const providerSessionState = new Map<string, ProviderSessionState>();
	return OFFICIAL_BODIES.map(({ step: stepIndex }) => {
		const request = buildRequest(
			model,
			contextAt(model, stepIndex),
			"<project>",
			{
				thinking: { enabled: true, level: "HIGH" },
				maxTokens: 262144,
				requestModelId: "gemini-4-carbon-high",
				providerSessionState,
				...options,
			},
			true,
		);
		// The stream records each response id as the next request's last_execution_id.
		const state = getAntigravityProviderSessionState(providerSessionState);
		if (state) state.lastExecutionId = `execution-after-step-${stepIndex}`;
		return normalizeEnvelope(wire(request));
	});
}

describe("Antigravity Gemini official request parity", () => {
	it("matches the four captured official bodies: signatures, roles, part ids, requestType, no toolConfig, tool packing and schemas", () => {
		const bodies = buildConversation({ antigravityRequestParity: true });
		for (const [index, { body }] of OFFICIAL_BODIES.entries()) {
			expect(bodies[index]).toEqual(normalizeEnvelope(body));
		}
	});

	it("keeps the baseline encoding when parity is off or unset", () => {
		const off = buildConversation({ antigravityRequestParity: false });
		expect(buildConversation({})).toEqual(off);

		const followUpBody = off[3];
		const request = followUpBody.request as { contents: Content[]; tools: unknown[]; toolConfig: unknown };
		expect("requestType" in followUpBody).toBe(false);
		expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
		expect(request.tools).toHaveLength(1);
		// Turn-opening steps replay unsigned (the call falls back to the sentinel), the
		// thought summary replays, and the result is an id-less user turn.
		expect(request.contents).toEqual([
			{ role: "user", parts: [{ text: userText(0) }] },
			{ role: "model", parts: [{ text: "PLAIN_CAPTURE_OK" }] },
			{ role: "user", parts: [{ text: userText(2) }] },
			{
				role: "model",
				parts: [
					{ thought: true, text: CALL_THOUGHT_SUMMARY },
					{ functionCall: { name: "read_file", args: { Path: FILE_PATH } }, thoughtSignature: SENTINEL },
				],
			},
			{ role: "user", parts: [{ functionResponse: { name: "read_file", response: { output: TOOL_OUTPUT } } }] },
			{ role: "model", parts: [{ text: "wire_capture_tool_result_4827", thoughtSignature: SIG_ANSWER }] },
			{ role: "user", parts: [{ text: userText(6) }] },
		]);
	});

	it("leaves Gemini CLI and Antigravity Claude requests unchanged", () => {
		const cli = geminiCli();
		const cliContext = contextAt(cli, 7);
		expect(wire(buildRequest(cli, cliContext, "project", { antigravityRequestParity: true }, false))).toEqual(
			wire(buildRequest(cli, cliContext, "project", {}, false)),
		);

		const claude = antigravityClaude();
		const claudeContext = contextAt(claude, 7);
		expect(
			normalizeEnvelope(
				wire(buildRequest(claude, claudeContext, "project", { antigravityRequestParity: true }, true)),
			),
		).toEqual(normalizeEnvelope(wire(buildRequest(claude, claudeContext, "project", {}, true))));
	});

	it("replays Hydrogen's own signed text and calls, while Carbon-attributed history stays unsigned on Hydrogen", () => {
		const hydrogen = hydrogenHigh();
		expect(hydrogen.identity.class).toBe("gemini");
		const parity: GoogleGeminiCliOptions = { antigravityRequestParity: true };

		// Hydrogen's own steps carry the same signed text and call continuity as the official Carbon follow-up.
		const own = buildRequest(hydrogen, { messages: conversation(hydrogen) }, "project", parity, true);
		expect(own.request.contents).toEqual(followUp.request.contents);

		// A model switch keeps the per-model replay policy: Carbon's signatures never ride a Hydrogen request,
		// so the opening call falls back to the sentinel and the texts go unsigned.
		const carbonHistory = conversation(carbon()).map(message =>
			message.role === "assistant"
				? { ...message, content: message.content.filter(block => block.type !== "thinking") }
				: message,
		);
		const switched = buildRequest(hydrogen, { messages: carbonHistory }, "project", parity, true);
		expect(modelSignatures(switched.request.contents)).toEqual([[undefined], [SENTINEL], [undefined]]);
	});

	it("replays real signatures, uses the sentinel only on an unsigned first call, and answers parallel calls in call order", () => {
		const model = carbon();
		const SIG_THOUGHT = "VEhPVUdIVA==";
		const SIG_A = "U0lHX0E=";
		const SIG_D = "U0lHX0Q=";
		const grep = (id: string, pattern: string, thoughtSignature?: string): ToolCall => ({
			type: "toolCall",
			id,
			name: "grep",
			arguments: { pattern },
			...(thoughtSignature && { thoughtSignature }),
		});
		const result = (toolCallId: string, timestamp: number): Message => ({
			role: "toolResult",
			toolCallId,
			toolName: "grep",
			content: [{ type: "text", text: `found ${toolCallId}` }],
			isError: false,
			timestamp,
		});
		const response = (id: string): Content => ({
			role: "model",
			parts: [{ functionResponse: { name: "grep", response: { output: `found ${id}` }, id } }],
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Search both", timestamp: 1 },
				step(
					model,
					[
						{ type: "thinking", thinking: "Plan", thinkingSignature: SIG_THOUGHT },
						grep("call_a", "a", SIG_A),
						grep("call_b", "b"),
					],
					"toolUse",
					2,
				),
				result("call_b", 3),
				result("call_a", 4),
				{ role: "user", content: "Again", timestamp: 5 },
				step(model, [grep("call_c", "c"), grep("call_d", "d", SIG_D)], "toolUse", 6),
				result("call_c", 7),
				result("call_d", 8),
			],
		};

		const request = buildRequest(model, context, "project", { antigravityRequestParity: true }, true);
		expect(request.request.contents).toEqual([
			{ role: "user", parts: [{ text: "Search both" }] },
			{
				role: "model",
				parts: [
					{ thought: true, text: "Plan", thoughtSignature: SIG_THOUGHT },
					{ functionCall: { name: "grep", args: { pattern: "a" }, id: "call_a" }, thoughtSignature: SIG_A },
					{ functionCall: { name: "grep", args: { pattern: "b" }, id: "call_b" } },
				],
			},
			response("call_a"),
			response("call_b"),
			{ role: "user", parts: [{ text: "Again" }] },
			{
				role: "model",
				parts: [
					{ functionCall: { name: "grep", args: { pattern: "c" }, id: "call_c" }, thoughtSignature: SENTINEL },
					{ functionCall: { name: "grep", args: { pattern: "d" }, id: "call_d" }, thoughtSignature: SIG_D },
				],
			},
			response("call_c"),
			response("call_d"),
		]);
	});

	it("omits toolConfig for every tool choice and restates only a forced choice in the transcript", () => {
		const model = carbon();
		const context: Context = {
			messages: [{ role: "user", content: "Read the fixture", timestamp: 1 }],
			tools: OFFICIAL_TOOLS.slice(0, 1),
		};
		const forced: GoogleGeminiCliOptions["toolChoice"] = { mode: "ANY", allowedFunctionNames: ["read_file"] };

		const on = buildRequest(model, context, "project", { toolChoice: forced, antigravityRequestParity: true }, true);
		const off = buildRequest(model, context, "project", { toolChoice: forced }, true);
		expect(on.request.toolConfig).toBeUndefined();
		expect(off.request.toolConfig).toEqual({
			functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] },
		});
		expect(on.request.contents).toHaveLength(2);
		expect(on.request.contents.at(-1)).toEqual(off.request.contents.at(-1));

		const none = buildRequest(
			model,
			context,
			"project",
			{ toolChoice: "none", antigravityRequestParity: true },
			true,
		);
		expect(none.request.toolConfig).toBeUndefined();
		expect(none.request.contents).toHaveLength(1);
	});

	it("encodes tool schemas as Google Schema proto JSON, keeping proto bounds and dropping what the proto lacks", () => {
		expect(
			normalizeSchemaForAntigravityGemini({
				type: "object",
				properties: {
					mode: { type: "integer", enum: [1, 2], minimum: 0, maximum: 9 },
					name: { type: "string", description: "Name", maxLength: 64, pattern: "^[a-z]+$" },
					tags: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 4 },
				},
				required: ["name"],
				additionalProperties: false,
			}),
		).toEqual({
			type: "OBJECT",
			properties: {
				mode: { type: "INTEGER", minimum: 0, maximum: 9 },
				name: { type: "STRING", description: 'Name\n\n{pattern: "^[a-z]+$"}', maxLength: "64" },
				tags: { type: "ARRAY", items: { type: "STRING", minLength: "1" }, maxItems: "4" },
			},
			required: ["name"],
		});
	});
});
