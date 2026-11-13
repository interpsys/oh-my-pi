import { afterEach, expect, test } from "bun:test";
import * as os from "node:os";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { VALUELESS_FLAGS } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { connectToServer, MCPManager, MCPProcessOptOutError } from "@oh-my-pi/pi-coding-agent/mcp";

const savedOptOut = process.env.OMP_NO_MCP;
afterEach(() => {
	if (savedOptOut === undefined) delete process.env.OMP_NO_MCP;
	else process.env.OMP_NO_MCP = savedOptOut;
});

test("--no-mcp parses as a value-less flag", () => {
	expect(parseArgs(["--no-mcp", "hello"])).toMatchObject({ noMcp: true, messages: ["hello"] });
	expect(parseArgs([]).noMcp).toBeUndefined();
	expect(VALUELESS_FLAGS.has("--no-mcp")).toBe(true);
});

test("OMP_NO_MCP=1 reads no MCP config and refuses every server start", async () => {
	let configLoads = 0;
	const loadConfigs = async () => {
		configLoads++;
		return { configs: {}, sources: {}, exaApiKeys: [] };
	};

	await new MCPManager(os.tmpdir(), null, loadConfigs).discoverAndConnect();
	expect(configLoads).toBe(1);

	process.env.OMP_NO_MCP = "1";
	expect(await new MCPManager(os.tmpdir(), null, loadConfigs).discoverAndConnect()).toMatchObject({
		connectedServers: [],
		tools: [],
	});
	expect(configLoads).toBe(1);
	await expect(connectToServer("stub", { command: "true" })).rejects.toBeInstanceOf(MCPProcessOptOutError);
});
