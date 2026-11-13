/**
 * Explicit post-startup MCP connects, run in their own process so `--no-mcp`'s
 * process flag cannot leak into the test runner.
 *
 * `bun mcp-process-opt-out-probe.ts <flag|none> <cwd> <serverName>` optionally
 * opts out as `--no-mcp` does, then tries every explicit way to start a
 * server: `discoverAndConnect` (what `/mcp reload` runs), `connectServers`
 * (`/mcp enable`, ACP client servers, reconnects) and a bare `connectToServer`
 * (`/mcp test`, OAuth probes). Prints one JSON line with what happened.
 */
import { connectToServer, disconnectServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { disableMCPForProcess, isMCPDisabledForProcess } from "@oh-my-pi/pi-coding-agent/mcp/process-opt-out";

const [optOut, cwd, serverName] = process.argv.slice(2);
if ((optOut !== "flag" && optOut !== "none") || !cwd || !serverName) {
	throw new Error("usage: mcp-process-opt-out-probe.ts <flag|none> <cwd> <serverName>");
}
// Resolve the config before opting out: the opt-out must hold even for a caller that already has one.
const { configs } = await loadAllMCPConfigs(cwd);
const config = configs[serverName];
if (!config) throw new Error(`MCP server "${serverName}" is not configured under ${cwd}`);
if (optOut === "flag") disableMCPForProcess();

const discoveryManager = new MCPManager(cwd);
const discovered = await discoveryManager.discoverAndConnect({ enableProjectConfig: true });
await discoveryManager.disconnectAll();

const connectManager = new MCPManager(cwd);
const connected = await connectManager.connectServers({ [serverName]: config }, {});
await connectManager.disconnectAll();

let direct: string;
try {
	await disconnectServer(await connectToServer(serverName, config));
	direct = "connected";
} catch (error) {
	direct = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

console.log(
	JSON.stringify({
		disabled: isMCPDisabledForProcess(),
		discovered: {
			connectedServers: discovered.connectedServers,
			tools: discovered.tools.map(tool => tool.name),
		},
		connected: {
			connectedServers: connected.connectedServers,
			tools: connected.tools.map(tool => tool.name),
			errors: Object.fromEntries(connected.errors),
		},
		direct,
	}),
);
