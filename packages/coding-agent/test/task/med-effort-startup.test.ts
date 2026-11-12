/**
 * `effort: "med"` must resolve exactly like an omitted effort through real SDK
 * startup (model default > settings default), except for the task.maxEffort
 * ceiling that any hint applies.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const createRealSession = sdkModule.createAgentSession;

describe("med task effort through real SDK startup", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		{
			name: "model default differs from settings default",
			modelDefault: "low",
			maxEffort: "max",
			omitted: "low",
			med: "low",
		},
		{ name: "settings default", modelDefault: undefined, maxEffort: "max", omitted: "high", med: "high" },
		{ name: "ceiling clamps the hint only", modelDefault: undefined, maxEffort: "low", omitted: "high", med: "low" },
	] as const)("$name", async ({ modelDefault, maxEffort, omitted, med }) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "med-effort-startup-"));
		const authStorage = createInMemoryAuthStorage();
		const registry = new ModelRegistry(authStorage, path.join(dir, "models.yml"));
		const base = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!base) throw new Error("Expected bundled gpt-5.6-sol model");
		const model = {
			...base,
			provider: "med-provider",
			id: "default-reasoner",
			name: "Default Reasoner",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1",
			thinking: {
				mode: "effort",
				efforts: ["low", "medium", "high"],
				...(modelDefault ? { defaultLevel: modelDefault } : {}),
			},
		} as Model;
		vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
		const actual: (string | undefined)[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const created = await createRealSession({
				...options,
				agentDir: dir,
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["yield"],
			});
			const session = created.session;
			actual.push(session.thinkingLevel);
			const listeners = new Set<(event: AgentSessionEvent) => void>();
			vi.spyOn(session, "subscribe").mockImplementation(listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			});
			vi.spyOn(session, "prompt").mockImplementation(async () => {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_end",
						toolCallId: "med-yield",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "Result submitted." }],
							details: { status: "success", data: { ok: true } },
						},
						isError: false,
					});
				}
				return true;
			});
			return created;
		});
		try {
			for (const effort of [undefined, "med"] as const) {
				const result = await runSubprocess({
					cwd: dir,
					agent: {
						name: "med-task",
						description: "test",
						systemPrompt: "test",
						source: "bundled",
						model: ["med-provider/default-reasoner"],
					},
					task: "Inspect startup thinking only.",
					index: 0,
					id: `med-startup-${modelDefault ?? "none"}-${maxEffort}-${effort ?? "omitted"}`,
					effort,
					settings: Settings.isolated({ defaultThinkingLevel: "high", "task.maxEffort": maxEffort }),
					modelRegistry: registry,
					authStorage,
					enableLsp: false,
					enableMCP: false,
				});
				expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
			}
			expect(actual).toEqual([omitted, med]);
		} finally {
			authStorage.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
