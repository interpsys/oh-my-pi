import type { TerminalMultiplexerModule } from "./types";

/**
 * Rex hosts native terminal panes with their own scrollback. Recognize its
 * session for classification without opting into the in-place multiplexer
 * renderer; nested screen-grid multiplexers still take precedence.
 */
export const rexMultiplexer = {
	id: "rex",
	precedence: "outerApp",
	sessionEnvKeys: ["REX_SESSION"],
	ownsScreenGrid: false,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.REX_SESSION?.trim());
	},
} as const satisfies TerminalMultiplexerModule;
