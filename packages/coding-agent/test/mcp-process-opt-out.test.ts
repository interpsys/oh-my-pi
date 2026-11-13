/**
 * `--no-mcp` / `OMP_NO_MCP=1`: a process-only MCP opt-out.
 *
 * A real stdio MCP peer audits its spawn and every request it receives, so the
 * default launch (positive control) must show spawn → initialize → tools/list
 * and a mounted tool, while either opt-out must leave the audit empty and mount
 * nothing — across print (headless discovery), rpc and rpc-ui (deferred,
 * interactive-style discovery). Persisted MCP and settings files never change.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { VALUELESS_FLAGS } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { launchHelp } from "@oh-my-pi/pi-coding-agent/commands/launch-help";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Process } from "@oh-my-pi/pi-natives";
import { isRecord, ptree, readLines, removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const SERVER = "stub";
const DEVICE = `mcp__${SERVER}_regression_announce`;
const cli = path.join(import.meta.dir, "../src/cli.ts");
const peer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const probe = path.join(import.meta.dir, "fixtures/mcp-process-opt-out-probe.ts");
const fakeModel = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");

type OptOut = "default" | "--no-mcp" | "OMP_NO_MCP=1";
const OPT_OUTS: readonly OptOut[] = ["default", "--no-mcp", "OMP_NO_MCP=1"];
const LAUNCH_FLAGS = ["--model", "fake/fake-model", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp"];

let root: string;
let agentDir: string;
let project: string;
let env: Record<string, string>;
let model: ptree.ChildProcess<"pipe">;
let caseIndex = 0;

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-mcp-"));
	const home = path.join(root, "home");
	agentDir = path.join(home, ".omp/agent");
	project = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(project);
	await Bun.write(path.join(agentDir, "config.yml"), "retry:\n  enabled: false\n");
	// Do not inherit API keys, profiles, provider overrides, external-tool configs or an outer opt-out.
	env = {
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${Bun.env.PATH ?? ""}`,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		PI_CONFIG_DIR: ".omp",
		PI_CODING_AGENT_DIR: agentDir,
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
	};
	model = ptree.spawn([process.execPath, fakeModel, agentDir], {
		cwd: project,
		env,
		stdin: "pipe",
		detached: true,
		timeout: 300_000,
	});
	let ready = "";
	for await (const line of readLines(model.stdout, AbortSignal.timeout(10_000))) {
		ready = new TextDecoder().decode(line);
		break;
	}
	expect(ready, model.peekStderr()).toMatch(/^READY \d+/);
});

afterAll(async () => {
	model.stdin.end();
	model.kill();
	await model.exited.catch(() => {});
	await removeWithRetries(root);
});

/** Point the user MCP config at a fresh audit file; returns its path and the persisted-file snapshot. */
async function configureCase(): Promise<{ audit: string; persisted: () => Promise<string[]> }> {
	const audit = path.join(root, `audit-${caseIndex++}.jsonl`);
	await Bun.write(audit, "");
	await Bun.write(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { [SERVER]: { command: process.execPath, args: [peer, audit] } } }),
	);
	const persisted = () =>
		Promise.all(["mcp.json", "config.yml"].map(name => Bun.file(path.join(agentDir, name)).text()));
	return { audit, persisted };
}

async function auditEntries(audit: string): Promise<Record<string, unknown>[]> {
	const entries: unknown[] = Bun.JSONL.parse(await Bun.file(audit).text());
	return entries.map(entry => {
		if (!isRecord(entry)) throw new Error("Invalid MCP audit entry");
		return entry;
	});
}

async function reapPeers(audit: string): Promise<void> {
	for (const entry of await auditEntries(audit)) {
		if (entry.event === "spawn" && typeof entry.pid === "number") {
			await Process.fromPid(entry.pid)?.terminate({ gracefulMs: 0 });
		}
	}
}

function caseLaunch(optOut: OptOut): { args: string[]; env: Record<string, string> } {
	return {
		args: optOut === "--no-mcp" ? ["--no-mcp"] : [],
		env: optOut === "OMP_NO_MCP=1" ? { ...env, OMP_NO_MCP: "1" } : env,
	};
}

/** The read tool's text for this prompt's single `read` call. */
function readResult(events: AgentEvent[]): string {
	const end = events.find(event => event.type === "tool_execution_end");
	if (!end || end.type !== "tool_execution_end") throw new Error("Missing read tool result");
	expect(end.toolName).toBe("read");
	const content: (TextContent | ImageContent)[] = end.result.content;
	return content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

async function expectAudit(audit: string, optOut: OptOut): Promise<void> {
	const entries = await auditEntries(audit);
	if (optOut !== "default") {
		expect(entries).toEqual([]);
		return;
	}
	expect(entries.filter(entry => entry.event === "spawn")).toHaveLength(1);
	const methods = entries.map(entry => entry.method).filter(method => typeof method === "string");
	expect(methods).toEqual(expect.arrayContaining(["initialize", "tools/list"]));
}

describe("--no-mcp CLI surface", () => {
	test("parser, flag tables and help accept and document --no-mcp", () => {
		expect(parseArgs(["--no-mcp"]).noMcp).toBe(true);
		expect(parseArgs([]).noMcp).toBeUndefined();
		// Value-less: `--no-mcp --profile work` must still select the profile.
		expect(VALUELESS_FLAGS.has("--no-mcp")).toBe(true);
		expect(parseArgs(["--no-mcp", "hello"]).messages).toEqual(["hello"]);
		expect(launchHelp.flags["no-mcp"].description).toContain("OMP_NO_MCP=1");
	});

	test("buildSessionOptions disables MCP only for --no-mcp", async () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			const settings = Settings.isolated();
			const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
			const build = (args: string[]) =>
				buildSessionOptions(parseArgs(args), [], SessionManager.inMemory(), modelRegistry, settings);
			expect((await build(["--no-mcp"])).enableMCP).toBe(false);
			expect((await build([])).enableMCP).toBeUndefined();
		} finally {
			authStorage.close();
		}
	});

	test("root help lists --no-mcp", async () => {
		const help = Bun.spawnSync([process.execPath, cli, "--help"], { cwd: project, env });
		expect(help.exitCode).toBe(0);
		expect(help.stdout.toString()).toContain("--no-mcp");
	});
});

describe("process MCP opt-out with a real stdio MCP server", () => {
	for (const optOut of OPT_OUTS) {
		test(`print: ${optOut}`, async () => {
			const { audit, persisted } = await configureCase();
			const before = await persisted();
			const launch = caseLaunch(optOut);
			using child = ptree.spawn([process.execPath, cli, "-p", ...LAUNCH_FLAGS, ...launch.args, "read_uri xd://"], {
				cwd: project,
				env: launch.env,
				stdin: "pipe",
				detached: true,
				timeout: 60_000,
			});
			try {
				child.stdin.end();
				const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
				expect(exitCode, child.peekStderr()).toBe(0);
				// The fake model echoes the read result: the xd:// listing names mounted MCP tools.
				expect(stdout).toContain("tool said:");
				if (optOut === "default") expect(stdout).toContain(DEVICE);
				else expect(stdout).not.toContain(DEVICE);
				await expectAudit(audit, optOut);
				expect(await persisted()).toEqual(before);
			} finally {
				child.kill(undefined, 0);
				await child.exited.catch(() => {});
				await reapPeers(audit);
			}
		}, 60_000);

		for (const mode of ["rpc", "rpc-ui"] as const) {
			test(`${mode}: ${optOut}`, async () => {
				const { audit, persisted } = await configureCase();
				const before = await persisted();
				const launch = caseLaunch(optOut);
				using child = ptree.spawn(
					[process.execPath, cli, "--mode", mode, ...LAUNCH_FLAGS, "--no-prewalk", ...launch.args],
					{ cwd: project, env: launch.env, stdin: "pipe", detached: true, timeout: 60_000 },
				);
				using client = new RpcClient({
					spawn: () => ({
						stdin: child.stdin,
						stdout: child.stdout,
						exited: child.exited,
						peekStderr: () => child.peekStderr(),
						kill: (reason, graceMs) => child.kill(reason, graceMs),
					}),
				});
				try {
					await client.start();
					const state = await client.getState();
					expect(state.dumpTools?.map(tool => tool.name)).toEqual(expect.arrayContaining(["read", "write"]));
					const listing = readResult(await client.promptAndWait("read_uri xd://"));
					if (optOut === "default") expect(listing).toContain(DEVICE);
					else expect(listing).not.toContain(DEVICE);
					await expectAudit(audit, optOut);
					expect(await persisted()).toEqual(before);
				} finally {
					try {
						await client.stop();
					} finally {
						child.kill(undefined, 0);
						await child.exited.catch(() => {});
						await reapPeers(audit);
					}
				}
			}, 60_000);
		}
	}
});

describe("explicit MCP connects after startup", () => {
	for (const optOut of OPT_OUTS) {
		test(
			optOut,
			async () => {
				const { audit } = await configureCase();
				const launch = caseLaunch(optOut);
				try {
					const run = Bun.spawnSync(
						[process.execPath, probe, optOut === "--no-mcp" ? "flag" : "none", project, SERVER],
						{ cwd: project, env: launch.env, timeout: 60_000 },
					);
					expect(run.exitCode, run.stderr.toString()).toBe(0);
					const result = JSON.parse(run.stdout.toString().trim().split("\n").at(-1) ?? "");
					if (optOut === "default") {
						expect(result).toMatchObject({
							disabled: false,
							discovered: { connectedServers: [SERVER] },
							connected: { connectedServers: [SERVER] },
							direct: "connected",
						});
						expect((await auditEntries(audit)).filter(entry => entry.event === "spawn")).toHaveLength(3);
						return;
					}
					expect(result.disabled).toBe(true);
					// Discovery reads no config, so it reports no server at all.
					expect(result.discovered).toEqual({ connectedServers: [], tools: [] });
					expect(result.connected.connectedServers).toEqual([]);
					expect(result.connected.tools).toEqual([]);
					expect(result.connected.errors[SERVER]).toContain("MCP is disabled for this process");
					expect(result.direct).toStartWith("MCPProcessOptOutError:");
					expect(await auditEntries(audit)).toEqual([]);
				} finally {
					await reapPeers(audit);
				}
			},
			60_000,
		);
	}
});
