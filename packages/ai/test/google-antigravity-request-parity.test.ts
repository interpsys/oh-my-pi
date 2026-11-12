import { describe, expect, it } from "bun:test";
import {
	buildRequest,
	type GoogleGeminiCliOptions,
	getAntigravityProviderSessionState,
} from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Content, Part } from "@oh-my-pi/pi-ai/providers/google-types";
import {
	ANTIGRAVITY_REQUEST_COMPONENTS,
	type AntigravityRequestComponentOptions,
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
	type ProviderSessionState,
	type TJsonSchema,
	type Tool,
	type ToolCall,
	type Usage,
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

type Component = keyof AntigravityRequestComponentOptions;

/** One component switch set to `value`. */
function only(component: Component, value: boolean): AntigravityRequestComponentOptions {
	const options: AntigravityRequestComponentOptions = {};
	options[component] = value;
	return options;
}

/** Every component switch set to `value`. */
function every(value: boolean): AntigravityRequestComponentOptions {
	return Object.fromEntries(
		ANTIGRAVITY_REQUEST_COMPONENTS.map(component => [component, value]),
	) as AntigravityRequestComponentOptions;
}

// The preregistered arms set the umbrella and every component explicitly: A is
// the baseline, C only keeps signatures, D only adds `requestType: "agent"`.
const ARM_A: GoogleGeminiCliOptions = { antigravityRequestParity: false, ...every(false) };
const ARM_C: GoogleGeminiCliOptions = { ...ARM_A, antigravityKeepSignatures: true };
const ARM_D: GoogleGeminiCliOptions = { ...ARM_A, antigravityRequestTypeAgent: true };

type WireRequest = Body & { contents: Content[] };

/** The request of a captured or built wire body. */
function requestOf(body: Body): WireRequest {
	// Every body here is JSON of a Cloud Code Assist request, which always carries `request.contents`.
	const request = body.request as WireRequest;
	return request;
}

/** `body` with its request replaced by `edit(request)`. */
function editRequest(body: Body, edit: (request: WireRequest) => Body): Body {
	return { ...body, request: edit(requestOf(body)) };
}

/** `body` with every content part mapped through `edit`; `undefined` drops the part. */
function editParts(body: Body, edit: (part: Part) => Part | undefined): Body {
	return editRequest(body, request => ({
		...request,
		contents: request.contents.map(content => ({
			...content,
			parts: content.parts?.flatMap(part => edit(part) ?? []),
		})),
	}));
}

/** Exactly what each component alone changes in the captured conversation's baseline bodies. */
const CAPTURED_DELTAS: Array<[Component, (body: Body, index: number) => Body]> = [
	[
		"antigravityKeepSignatures",
		// The plain answer and the call open their turns: baseline sends them unsigned (the call with the sentinel).
		body =>
			editParts(body, part =>
				part.text === "PLAIN_CAPTURE_OK"
					? { ...part, thoughtSignature: SIG_PLAIN }
					: part.functionCall
						? { ...part, thoughtSignature: SIG_CALL }
						: part,
			),
	],
	["antigravityRequestTypeAgent", body => ({ ...body, requestType: "agent" })],
	[
		"antigravityFunctionIds",
		body =>
			editParts(body, part =>
				part.functionCall
					? { ...part, functionCall: { ...part.functionCall, id: CALL_ID } }
					: part.functionResponse
						? { ...part, functionResponse: { ...part.functionResponse, id: CALL_ID } }
						: part,
			),
	],
	[
		"antigravityModelFunctionResponses",
		body =>
			editRequest(body, request => ({
				...request,
				contents: request.contents.map(content =>
					content.parts?.every(part => part.functionResponse) ? { ...content, role: "model" } : content,
				),
			})),
	],
	[
		"antigravityOmitToolConfig",
		body =>
			editRequest(body, request =>
				Object.fromEntries(Object.entries(request).filter(([key]) => key !== "toolConfig")),
			),
	],
	[
		"antigravityToolPacking",
		(body, index) =>
			editRequest(body, request => ({ ...request, tools: requestOf(OFFICIAL_BODIES[index].body).tools })),
	],
	[
		"antigravityOmitUnsignedThoughts",
		body => editParts(body, part => (part.text === CALL_THOUGHT_SUMMARY ? undefined : part)),
	],
];

const CLOCK = "[now 2026-11-12 1:26:04 PM PST Thu · 2026-11-12 21:26Z]";
const SIG_OPEN_THOUGHT = "SigThoughtOnly00";
const SIG_READ_A = "SigReadCallA";
const SIG_LOOP_THOUGHT = "SigLoopThought00";
const SIG_GREP = "SigGrepCall0";
const SIG_FOUND = "SigFoundText";
const SIG_EDIT_THOUGHT = "SigEditThought00";
const SIG_EDIT_B = "SigEditCallB";
const SIG_DONE = "SigDoneText0";
const SIGNED_HISTORY_SIGNATURES = [
	SIG_OPEN_THOUGHT,
	SIG_READ_A,
	SIG_LOOP_THOUGHT,
	SIG_GREP,
	SIG_FOUND,
	SIG_EDIT_THOUGHT,
	SIG_EDIT_B,
	SIG_DONE,
];

function call(id: string, name: string, args: Record<string, unknown>, thoughtSignature?: string): ToolCall {
	return { type: "toolCall", id, name, arguments: args, ...(thoughtSignature && { thoughtSignature }) };
}

function output(toolCallId: string, toolName: string, text: string, timestamp: number): Message {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp };
}

/**
 * A signed agent history shaped like the recorded sessions: two steps open a
 * turn (after a prompt; after an injected clock line and a prompt) with an
 * unsigned summary, a signed thought, a signature-only thought, and parallel
 * calls signed first or second; the tool-loop steps between are signed.
 */
function signedHistory(model: Model): Message[] {
	return [
		{ role: "user", content: "Inspect a.ts and b.ts", timestamp: 1 },
		step(
			model,
			[
				{ type: "thinking", thinking: "Plan the read." },
				{ type: "thinking", thinking: "", thinkingSignature: SIG_OPEN_THOUGHT },
				call("call_read_a", "read_file", { Path: "/workspace/a.ts" }, SIG_READ_A),
				call("call_read_b", "read_file", { Path: "/workspace/b.ts" }),
			],
			"toolUse",
			2,
		),
		output("call_read_a", "read_file", "a.ts contents", 3),
		output("call_read_b", "read_file", "b.ts contents", 4),
		step(
			model,
			[
				{ type: "thinking", thinking: "Both files read.", thinkingSignature: SIG_LOOP_THOUGHT },
				call("call_grep", "grep_search", { Query: "bug" }, SIG_GREP),
			],
			"toolUse",
			5,
		),
		output("call_grep", "grep_search", "a.ts:3: bug", 6),
		step(model, [{ type: "text", text: "Found it in a.ts.", textSignature: SIG_FOUND }], "stop", 7),
		{ role: "developer", content: CLOCK, timestamp: 8 },
		{ role: "user", content: "Apply the fix", timestamp: 9 },
		step(
			model,
			[
				{ type: "thinking", thinking: "Edit now.", thinkingSignature: SIG_EDIT_THOUGHT },
				call("call_edit_a", "replace_file_content", { TargetFile: "/workspace/a.ts" }),
				call("call_edit_b", "replace_file_content", { TargetFile: "/workspace/b.ts" }, SIG_EDIT_B),
			],
			"toolUse",
			10,
		),
		output("call_edit_a", "replace_file_content", "edited a.ts", 11),
		output("call_edit_b", "replace_file_content", "edited b.ts", 12),
		step(model, [{ type: "text", text: "Done.", textSignature: SIG_DONE }], "stop", 13),
		{ role: "user", content: "Thanks", timestamp: 14 },
	];
}

const responsePart = (name: string, text: string): Part => ({ functionResponse: { name, response: { output: text } } });

/** The baseline (arm A) contents of {@link signedHistory}: steps opening a turn go unsigned, the tool loop stays signed. */
const SIGNED_HISTORY_BASELINE: Content[] = [
	{ role: "user", parts: [{ text: "Inspect a.ts and b.ts" }] },
	{
		role: "model",
		parts: [
			{ thought: true, text: "Plan the read." },
			{ functionCall: { name: "read_file", args: { Path: "/workspace/a.ts" } }, thoughtSignature: SENTINEL },
			{ functionCall: { name: "read_file", args: { Path: "/workspace/b.ts" } } },
		],
	},
	{
		role: "user",
		parts: [responsePart("read_file", "a.ts contents"), responsePart("read_file", "b.ts contents")],
	},
	{
		role: "model",
		parts: [
			{ thought: true, text: "Both files read.", thoughtSignature: SIG_LOOP_THOUGHT },
			{ functionCall: { name: "grep_search", args: { Query: "bug" } }, thoughtSignature: SIG_GREP },
		],
	},
	{ role: "user", parts: [responsePart("grep_search", "a.ts:3: bug")] },
	{ role: "model", parts: [{ text: "Found it in a.ts.", thoughtSignature: SIG_FOUND }] },
	{ role: "user", parts: [{ text: CLOCK }] },
	{ role: "user", parts: [{ text: "Apply the fix" }] },
	{
		role: "model",
		parts: [
			{ thought: true, text: "Edit now." },
			{
				functionCall: { name: "replace_file_content", args: { TargetFile: "/workspace/a.ts" } },
				thoughtSignature: SENTINEL,
			},
			{ functionCall: { name: "replace_file_content", args: { TargetFile: "/workspace/b.ts" } } },
		],
	},
	{
		role: "user",
		parts: [responsePart("replace_file_content", "edited a.ts"), responsePart("replace_file_content", "edited b.ts")],
	},
	{ role: "model", parts: [{ text: "Done.", thoughtSignature: SIG_DONE }] },
	{ role: "user", parts: [{ text: "Thanks" }] },
];

/**
 * Arm C's contents of {@link signedHistory}: only the two turn-opening steps
 * change, replaying their real signatures (the signature-only thought comes
 * back with its signature, an unsigned first call keeps the sentinel, an
 * unsigned second call stays bare); the unsigned summary still replays.
 */
const SIGNED_HISTORY_KEEP_SIGNATURES = SIGNED_HISTORY_BASELINE.with(1, {
	role: "model",
	parts: [
		{ thought: true, text: "Plan the read." },
		{ thought: true, text: "", thoughtSignature: SIG_OPEN_THOUGHT },
		{ functionCall: { name: "read_file", args: { Path: "/workspace/a.ts" } }, thoughtSignature: SIG_READ_A },
		{ functionCall: { name: "read_file", args: { Path: "/workspace/b.ts" } } },
	],
}).with(8, {
	role: "model",
	parts: [
		{ thought: true, text: "Edit now.", thoughtSignature: SIG_EDIT_THOUGHT },
		{
			functionCall: { name: "replace_file_content", args: { TargetFile: "/workspace/a.ts" } },
			thoughtSignature: SENTINEL,
		},
		{
			functionCall: { name: "replace_file_content", args: { TargetFile: "/workspace/b.ts" } },
			thoughtSignature: SIG_EDIT_B,
		},
	],
});

/** One request for `messages` on `model`, with the captured system prompt, tools and thinking setup. */
function historyBody(model: Model<"google-gemini-cli">, messages: Message[], options: GoogleGeminiCliOptions): Body {
	const context: Context = {
		systemPrompt: followUp.request.systemInstruction.parts.map(part => part.text),
		messages,
		tools: OFFICIAL_TOOLS,
	};
	const request = buildRequest(
		model,
		context,
		"<project>",
		{
			thinking: { enabled: true, level: "HIGH" },
			maxTokens: 262144,
			providerSessionState: new Map<string, ProviderSessionState>(),
			...options,
		},
		true,
	);
	return normalizeEnvelope(wire(request));
}

describe("Antigravity Gemini official request parity", () => {
	it("matches the four captured official bodies: signatures, roles, part ids, requestType, no toolConfig, tool packing and schemas", () => {
		const official = OFFICIAL_BODIES.map(({ body }) => normalizeEnvelope(body));
		expect(buildConversation({ antigravityRequestParity: true })).toEqual(official);
		// Every component on gives the same bodies, whatever the umbrella says.
		expect(buildConversation(every(true))).toEqual(official);
		expect(buildConversation({ antigravityRequestParity: false, ...every(true) })).toEqual(official);
	});

	it("keeps the baseline encoding with every component off, and when parity is off or unset", () => {
		const off = buildConversation(ARM_A);
		expect(buildConversation({})).toEqual(off);
		expect(buildConversation({ antigravityRequestParity: false })).toEqual(off);
		// Explicit component switches override the umbrella.
		expect(buildConversation({ antigravityRequestParity: true, ...every(false) })).toEqual(off);

		const followUpBody = off[3];
		const request = requestOf(followUpBody);
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

	it.each(CAPTURED_DELTAS)("%s alone changes only its own part of the captured bodies", (component, delta) => {
		const baseline = buildConversation(ARM_A);
		const expected = baseline.map(delta);
		expect(expected).not.toEqual(baseline);
		expect(buildConversation({ ...ARM_A, ...only(component, true) })).toEqual(expected);
	});

	it.each([...ANTIGRAVITY_REQUEST_COMPONENTS])("%s: set overrides the umbrella, unset inherits it", component => {
		const allOn = buildConversation(every(true));
		const umbrellaOnComponentOff = buildConversation({ antigravityRequestParity: true, ...only(component, false) });
		expect(umbrellaOnComponentOff).toEqual(buildConversation({ ...every(true), ...only(component, false) }));
		expect(umbrellaOnComponentOff).not.toEqual(allOn);
		expect(buildConversation({ antigravityRequestParity: true, ...only(component, true) })).toEqual(allOn);
		expect(buildConversation({ antigravityRequestParity: false, ...only(component, true) })).toEqual(
			buildConversation({ ...ARM_A, ...only(component, true) }),
		);
	});

	it("arm C differs from arm A only in the turn-opening signatures of a signed multi-turn history", () => {
		const model = carbon();
		const baseline = historyBody(model, signedHistory(model), ARM_A);
		expect(requestOf(baseline).contents).toEqual(SIGNED_HISTORY_BASELINE);
		expect(historyBody(model, signedHistory(model), ARM_C)).toEqual(
			editRequest(baseline, request => ({ ...request, contents: SIGNED_HISTORY_KEEP_SIGNATURES })),
		);
	});

	it("arm D differs from arm A only in requestType", () => {
		const model = carbon();
		const baseline = historyBody(model, signedHistory(model), ARM_A);
		expect("requestType" in baseline).toBe(false);
		expect(historyBody(model, signedHistory(model), ARM_D)).toEqual({ ...baseline, requestType: "agent" });
		const capturedBaseline = buildConversation(ARM_A);
		expect(buildConversation(ARM_D)).toEqual(capturedBaseline.map(body => ({ ...body, requestType: "agent" })));
	});

	it("model-role tool results alone keep the tool loop's signatures", () => {
		const model = carbon();
		const body = historyBody(model, signedHistory(model), { ...ARM_A, antigravityModelFunctionResponses: true });
		// Each response becomes its own model-role content in call order; steps after
		// them still continue the tool loop, so their signatures replay as in arm A.
		expect(requestOf(body).contents).toEqual(
			SIGNED_HISTORY_BASELINE.flatMap(content =>
				content.parts?.every(part => part.functionResponse)
					? content.parts.map(part => ({ role: "model", parts: [part] }))
					: [content],
			),
		);
	});

	it("omitting unsigned thoughts alone drops only summaries stored without a signature", () => {
		const model = carbon();
		const body = historyBody(model, signedHistory(model), { ...ARM_A, antigravityOmitUnsignedThoughts: true });
		// The opening step's unsigned summary goes; the signed thought of the later
		// opening step stays in its slot, unsigned on the wire as in arm A.
		expect(requestOf(body).contents).toEqual(
			SIGNED_HISTORY_BASELINE.with(1, {
				role: "model",
				parts: SIGNED_HISTORY_BASELINE[1].parts?.filter(part => part.text !== "Plan the read."),
			}),
		);
	});

	it("arm C replays Hydrogen's own signatures and never transplants Carbon's onto Hydrogen", () => {
		const hydrogen = hydrogenHigh();
		expect(hydrogen.identity.class).toBe("gemini");

		const own = historyBody(hydrogen, signedHistory(hydrogen), ARM_A);
		expect(requestOf(own).contents).toEqual(SIGNED_HISTORY_BASELINE);
		expect(historyBody(hydrogen, signedHistory(hydrogen), ARM_C)).toEqual(
			editRequest(own, request => ({ ...request, contents: SIGNED_HISTORY_KEEP_SIGNATURES })),
		);

		// Carbon-attributed history on Hydrogen: no signature is Hydrogen's, so C sends exactly arm A's body.
		const switched = historyBody(hydrogen, signedHistory(carbon()), ARM_C);
		expect(switched).toEqual(historyBody(hydrogen, signedHistory(carbon()), ARM_A));
		const wireText = JSON.stringify(switched);
		for (const signature of SIGNED_HISTORY_SIGNATURES) expect(wireText).not.toContain(signature);
	});

	it("leaves Gemini CLI and Antigravity Claude requests unchanged", () => {
		const cli = geminiCli();
		const cliContext = contextAt(cli, 7);
		for (const options of [{ antigravityRequestParity: true }, every(true)]) {
			expect(wire(buildRequest(cli, cliContext, "project", options, false))).toEqual(
				wire(buildRequest(cli, cliContext, "project", {}, false)),
			);
		}

		const claude = antigravityClaude();
		const claudeContext = contextAt(claude, 7);
		for (const options of [{ antigravityRequestParity: true }, every(true)]) {
			expect(normalizeEnvelope(wire(buildRequest(claude, claudeContext, "project", options, true)))).toEqual(
				normalizeEnvelope(wire(buildRequest(claude, claudeContext, "project", {}, true))),
			);
		}
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

		// The switch alone omits toolConfig the same way; set off, it keeps toolConfig under the umbrella.
		const omitOnly = buildRequest(
			model,
			context,
			"project",
			{ toolChoice: forced, ...ARM_A, antigravityOmitToolConfig: true },
			true,
		);
		expect(omitOnly.request.toolConfig).toBeUndefined();
		expect(omitOnly.request.contents).toEqual(on.request.contents);
		const keepToolConfig = buildRequest(
			model,
			context,
			"project",
			{ toolChoice: forced, antigravityRequestParity: true, antigravityOmitToolConfig: false },
			true,
		);
		expect(keepToolConfig.request.toolConfig).toEqual(off.request.toolConfig);
		expect(keepToolConfig.request.contents).toEqual(on.request.contents);
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
