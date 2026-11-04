import { afterEach, describe, expect, it } from "bun:test";
import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import { convertToLlm, wrapSteeringForModel } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildBudgetNotice } from "@oh-my-pi/pi-coding-agent/task/executor";

/**
 * Contract: the "User interjection" envelope marks only steers the user typed.
 * Steers the harness or a parent agent sends (`attribution: "agent"`) reach the
 * model in their own envelope, never labelled as user intent.
 */

/** The text a model reads for `messages`, through the same conversion a provider request uses. */
function modelText(messages: AgentMessage[]): string {
	return convertToLlm(wrapSteeringForModel(messages))
		.flatMap((message: Message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])),
		)
		.join("\n");
}

function makeBridge(streaming: boolean) {
	const steered: AgentMessage[] = [];
	const host = {
		agent: { steer: (message: AgentMessage) => steered.push(message) } as unknown as Agent,
		isDisposed: () => false,
		isStreaming: () => streaming,
		planModeEnabled: () => false,
		emitSessionEvent: async () => {},
		wakeForIrc: () => {},
	} as unknown as IrcBridgeHost;
	return { bridge: new IrcBridge(host), steered };
}

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

describe("steering envelope attribution", () => {
	it("sends the harness request-budget notice without the user-interjection envelope", () => {
		const notice: AgentMessage = {
			role: "user",
			content: buildBudgetNotice(100, 100),
			steering: true,
			attribution: "agent",
			timestamp: 1,
		};

		const text = modelText([notice]);
		expect(text).not.toContain("User interjection");
		expect(text.startsWith('<system-notice source="harness" kind="request-budget">')).toBe(true);
	});

	it("labels a parent's mid-turn message as the parent's, not the user's", async () => {
		AgentRegistry.global().register({ id: "Sub", displayName: "Sub", kind: "sub", parentId: "Main", session: null });
		const { bridge, steered } = makeBridge(true);
		await bridge.deliver({ id: "m1", from: "Main", to: "Sub", body: "Stop after the current file.", ts: 1 });

		expect(steered).toHaveLength(1);
		const text = modelText(steered);
		expect(text).not.toContain("User interjection");
		expect(text).toContain("It comes from your parent agent, not the user.");
		expect(text).toContain('<irc from="parent" agent="Main">');
		expect(text).toContain("Stop after the current file.");
	});

	it("keeps the user-interjection envelope on user-typed steers", () => {
		for (const attribution of ["user", undefined] as const) {
			const steer: AgentMessage = {
				role: "user",
				content: "Use the staging bucket instead.",
				steering: true,
				attribution,
				timestamp: 1,
			};

			const text = modelText([steer]);
			expect(text).toContain("User interjection during work");
			expect(text).toContain("Use the staging bucket instead.");
		}
	});
});
