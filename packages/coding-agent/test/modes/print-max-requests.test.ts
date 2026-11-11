/**
 * Contract: `omp -p --max-requests N` lets the agent send N model requests. The
 * run then stops before the next one, once the last response's tool results are
 * recorded, prints that response's text as usual and exits 3. A run that ends
 * within N requests, or one without the option, exits as before.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	clearCustomApis,
	type Model,
	type ModelSpec,
	registerCustomApi,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	PRINT_MODE_REQUEST_LIMIT_EXIT_CODE,
	type PrintModeOptions,
	runPrintMode,
} from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

/** Text plus a tool call: the loop runs the tool and needs another request for its result. */
function toolTurn(text: string, id: string): AssistantMessage {
	const message = createAssistantMessage(text);
	message.content.push({ type: "toolCall", id, name: "lookup", arguments: {} });
	message.stopReason = "toolUse";
	return message;
}

/** Streams `message` the way a provider does: its tool calls are complete before the final `done`. */
function streamOf(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		message.content.forEach((block, contentIndex) => {
			if (block.type !== "toolCall") return;
			stream.push({ type: "toolcall_start", contentIndex, partial: message });
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
		});
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	});
	return stream;
}

describe("print mode --max-requests", () => {
	const tempDirs: TempDir[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		clearCustomApis();
		for (const storage of authStorages.splice(0)) storage.close();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	/** Registers a provider that answers with `responses` in order and counts the requests it got. */
	function scriptedProvider(api: string, responses: AssistantMessage[]): { calls: () => number } {
		let calls = 0;
		registerCustomApi(api, () => streamOf(structuredClone(responses[Math.min(calls++, responses.length - 1)])));
		return { calls: () => calls };
	}

	async function createSession(api: string): Promise<AgentSession> {
		const tempDir = TempDir.createSync("@omp-max-requests-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			// A keyless model on a custom API, so the scripted provider needs no credentials.
			model: buildModel({
				id: "max-requests-model",
				name: "Max Requests Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 1024,
				api,
				provider: "llama.cpp",
				baseUrl: "http://127.0.0.1:8080/v1",
			} as ModelSpec<Api>) as Model<Api>,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		return session;
	}

	/**
	 * Runs print mode in text mode over a scripted provider, capturing stdout, stderr and the
	 * recorded messages (print mode disposes the session, which clears its message list).
	 */
	async function runScripted(
		api: string,
		responses: AssistantMessage[],
		options: Omit<PrintModeOptions, "mode">,
	): Promise<{ exitCode: number; calls: number; stdout: string; stderr: string; messages: AgentMessage[] }> {
		const provider = scriptedProvider(api, responses);
		const session = await createSession(api);
		const messages: AgentMessage[] = [];
		session.subscribe(event => {
			if (event.type === "message_end") messages.push(event.message);
		});
		const stdout: string[] = [];
		const stderr: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			stdout.push(String(args[0]));
			const cb = args[args.length - 1];
			if (typeof cb === "function") (cb as (err?: Error | null) => void)(null);
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		});
		const exitCode = await runPrintMode(session, { mode: "text", ...options });
		vi.restoreAllMocks();
		return { exitCode, calls: provider.calls(), stdout: stdout.join(""), stderr: stderr.join(""), messages };
	}

	it("stops after N requests once the tool results are recorded, prints the last text and exits 3", async () => {
		const run = await runScripted(
			"test-max-requests-stop",
			[
				toolTurn("Reading the first file", "call_1"),
				toolTurn("Reading the second file", "call_2"),
				createAssistantMessage("Done"),
			],
			{ initialMessage: "go", maxRequests: 2 },
		);

		expect(run.exitCode).toBe(PRINT_MODE_REQUEST_LIMIT_EXIT_CODE);
		expect(PRINT_MODE_REQUEST_LIMIT_EXIT_CODE).toBe(3);
		expect(run.calls).toBe(2);
		expect(run.stdout).toContain("Reading the second file");
		expect(run.stdout).not.toContain("Reading the first file");
		expect(run.stdout).not.toContain("Done");
		expect(run.stderr).toContain("Request limit reached: 2 model requests sent (--max-requests)");
		// The second response's tool ran and its result is the transcript's last entry; no stop message follows.
		const last = run.messages.at(-1);
		expect(last?.role).toBe("toolResult");
		expect(last?.role === "toolResult" ? last.toolCallId : undefined).toBe("call_2");
		expect(run.messages.filter(message => message.role === "assistant")).toHaveLength(2);
	});

	it("runs to the final answer without the option", async () => {
		const run = await runScripted(
			"test-max-requests-unset",
			[
				toolTurn("Reading the first file", "call_1"),
				toolTurn("Reading the second file", "call_2"),
				createAssistantMessage("Done"),
			],
			{ initialMessage: "go" },
		);

		expect(run.exitCode).toBe(0);
		expect(run.calls).toBe(3);
		expect(run.stdout).toContain("Done");
		expect(run.stderr).not.toContain("Request limit reached");
	});

	it("exits 0 when the run finishes within the limit", async () => {
		const run = await runScripted(
			"test-max-requests-within",
			[toolTurn("Reading the file", "call_1"), createAssistantMessage("Done")],
			{ initialMessage: "go", maxRequests: 2 },
		);

		expect(run.exitCode).toBe(0);
		expect(run.calls).toBe(2);
		expect(run.stdout).toContain("Done");
		expect(run.stderr).not.toContain("Request limit reached");
	});

	it("does not prompt later inputs once the budget is spent", async () => {
		const run = await runScripted(
			"test-max-requests-inputs",
			[createAssistantMessage("First answer"), createAssistantMessage("Second answer")],
			{ initialMessage: "first", messages: ["second"], maxRequests: 1 },
		);

		expect(run.exitCode).toBe(PRINT_MODE_REQUEST_LIMIT_EXIT_CODE);
		expect(run.calls).toBe(1);
		expect(run.stdout).toContain("First answer");
		expect(run.messages.filter(message => message.role === "user")).toHaveLength(1);
	});
});

describe("--max-requests parsing", () => {
	it("parses a positive request count", () => {
		expect(parseArgs(["--max-requests", "2", "-p", "go"]).maxRequests).toBe(2);
		expect(parseArgs(["-p", "go"]).maxRequests).toBeUndefined();
	});

	for (const value of ["0", "-1", "1.5", "abc", "", "1e3"]) {
		it(`rejects ${JSON.stringify(value)}`, () => {
			expect(() => parseArgs(["--max-requests", value])).toThrow(CliUsageError);
			expect(() => parseArgs(["--max-requests", value])).toThrow("Invalid --max-requests value");
		});
	}
});
