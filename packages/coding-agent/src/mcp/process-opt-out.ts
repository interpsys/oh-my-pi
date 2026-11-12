/**
 * Process-scoped MCP opt-out.
 *
 * `--no-mcp` or `OMP_NO_MCP=1` turns MCP off for this process only: no MCP
 * config discovery, no server startup and no MCP tools. Nothing is persisted:
 * `mcp.json` (`disabledServers`) and settings stay untouched, so other omp
 * processes keep their MCP servers. The flag never leaks into child processes;
 * the environment variable is inherited like any other environment.
 */
import { $flag } from "@oh-my-pi/pi-utils";

/** Environment variable that opts a process out of MCP. */
export const MCP_PROCESS_OPT_OUT_ENV = "OMP_NO_MCP";

let disabledByFlag = false;

/** Opt this process out of MCP (`--no-mcp`). There is no way back for the process. */
export function disableMCPForProcess(): void {
	disabledByFlag = true;
}

/** Whether `--no-mcp` or `OMP_NO_MCP` opted this process out of MCP. The environment is read per call. */
export function isMCPDisabledForProcess(): boolean {
	return disabledByFlag || $flag(MCP_PROCESS_OPT_OUT_ENV);
}

/** Raised when something tries to start an MCP server in an opted-out process. */
export class MCPProcessOptOutError extends Error {
	constructor(serverName: string) {
		super(
			`MCP server "${serverName}" was not started: MCP is disabled for this process (--no-mcp or ${MCP_PROCESS_OPT_OUT_ENV}=1)`,
		);
		this.name = "MCPProcessOptOutError";
	}
}
