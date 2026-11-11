import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PRINT_MODE_MAX_REQUESTS_EXIT_CODE, runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function captureOutput(): { stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		stdout.push(String(args[0]));
		const callback = args.at(-1);
		if (typeof callback === "function") callback();
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	});
	return { stdout, stderr };
}

/**
 * A session whose model answers from `responses` and can call one `probe` tool. `transcript`
 * collects every finished message: print mode disposes the session, which clears its state.
 */
async function createSession(responses: MockResponse[]): Promise<{
	session: AgentSession;
	model: MockModel;
	probeCalls: () => number;
	transcript: AgentMessage[];
}> {
	const dir = TempDir.createSync("@pi-print-max-requests-");
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	cleanups.push(async () => {
		auth.close();
		await dir.remove();
	});
	let probes = 0;
	const probe: AgentTool = {
		name: "probe",
		label: "Probe",
		description: "Returns a fixed observation",
		parameters: type({}),
		execute: async () => {
			probes++;
			return { content: [{ type: "text", text: `PROBE_RESULT_${probes}` }] };
		},
	};
	const model = createMockModel({ responses });
	auth.keys.setRuntime(model.provider, "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [probe], messages: [] },
			convertToLlm,
			streamFn: model.stream,
		}),
		sessionManager: SessionManager.inMemory(dir.path()),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
	});
	const transcript: AgentMessage[] = [];
	session.subscribe(event => {
		if (event.type === "message_end") transcript.push(event.message);
	});
	cleanups.push(() => session.dispose());
	return { session, model, probeCalls: () => probes, transcript };
}

const toolTurn = (text: string): MockResponse => ({
	content: [text, { type: "toolCall", name: "probe", arguments: {} }],
});

describe("print mode --max-requests", () => {
	it("stops after N requests once their tool results are recorded, prints the last reply, and exits 3", async () => {
		const { session, model, probeCalls, transcript } = await createSession([
			toolTurn("Checking first."),
			toolTurn("Checking again."),
			toolTurn("UNSENT third request"),
			{ content: ["UNSENT final answer"] },
		]);
		const output = captureOutput();

		const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "go", maxRequests: 2 });

		expect(exitCode).toBe(PRINT_MODE_MAX_REQUESTS_EXIT_CODE);
		expect(exitCode).toBe(3);
		expect(model.calls).toHaveLength(2);
		// The second reply's tool call ran and its result is recorded last.
		expect(probeCalls()).toBe(2);
		const toolResults = transcript.flatMap(message =>
			message.role === "toolResult"
				? message.content.flatMap(block => (block.type === "text" ? [block.text] : []))
				: [],
		);
		expect(toolResults).toEqual(["PROBE_RESULT_1", "PROBE_RESULT_2"]);
		expect(transcript.at(-1)?.role).toBe("toolResult");
		expect(output.stdout.join("")).toBe("Checking again.\n");
		expect(output.stderr.join("")).toContain("Request limit reached");
	});

	it("leaves later prompts unsent once the limit is spent", async () => {
		const { session, model, transcript } = await createSession([
			{ content: ["First answer"] },
			{ content: ["UNSENT"] },
		]);
		const output = captureOutput();

		const exitCode = await runPrintMode(session, {
			mode: "text",
			initialMessage: "first",
			messages: ["second"],
			maxRequests: 1,
		});

		expect(exitCode).toBe(PRINT_MODE_MAX_REQUESTS_EXIT_CODE);
		expect(model.calls).toHaveLength(1);
		expect(transcript.filter(message => message.role === "user")).toHaveLength(1);
		expect(output.stdout.join("")).toBe("First answer\n");
	});

	it("exits 0 when the run finishes within the limit", async () => {
		const { session, model } = await createSession([toolTurn("Checking."), { content: ["Done."] }]);
		const output = captureOutput();

		const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "go", maxRequests: 2 });

		expect(exitCode).toBe(0);
		expect(model.calls).toHaveLength(2);
		expect(output.stdout.join("")).toBe("Done.\n");
		expect(output.stderr.join("")).not.toContain("Request limit reached");
	});

	it("runs to completion without the option", async () => {
		const { session, model, probeCalls } = await createSession([
			toolTurn("Checking first."),
			toolTurn("Checking again."),
			{ content: ["Final answer"] },
		]);
		const output = captureOutput();

		const exitCode = await runPrintMode(session, { mode: "text", initialMessage: "go" });

		expect(exitCode).toBe(0);
		expect(model.calls).toHaveLength(3);
		expect(probeCalls()).toBe(2);
		expect(output.stdout.join("")).toBe("Final answer\n");
	});

	it("parses a positive whole number and rejects anything else", () => {
		expect(parseArgs(["--max-requests", "20", "-p", "hi"]).maxRequests).toBe(20);
		expect(parseArgs(["-p", "hi"]).maxRequests).toBeUndefined();
		for (const value of ["0", "-1", "1.5", "abc", "", "Infinity"]) {
			expect(() => parseArgs(["--max-requests", value])).toThrow("Invalid --max-requests value");
		}
	});
});
