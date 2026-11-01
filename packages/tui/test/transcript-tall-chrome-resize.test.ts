import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const COLUMNS = 150;
const EXPECTED = ["TABLEINTRO", "Job", "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "TABLEOUTRO"];
const MARKER = /\b(TABLEINTRO|Job|Alpha|Beta|Gamma|Delta|Epsilon|TABLEOUTRO)\b/;

class LiveChrome implements Component {
	rows = 0;

	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, index) => `Live chrome ${index}`);
	}
}

function reply(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: [
					"TABLEINTRO",
					"",
					"| Job | Next step |",
					"| --- | --- |",
					"| Alpha | First task |",
					"| Beta | Second task |",
					"| Gamma | Third task |",
					"| Delta | Fourth task |",
					"| Epsilon | Fifth task |",
					"",
					"TABLEOUTRO",
				].join("\n"),
			},
		],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "test",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

/** Preserve ordering and duplicates so missing or repeated transcript rows both fail. */
function markers(rows: readonly string[]): string[] {
	return rows.flatMap(row => {
		const match = MARKER.exec(Bun.stripANSI(row));
		return match ? [match[1]!] : [];
	});
}

beforeAll(async () => {
	await initTheme();
});

describe("settled transcript under live chrome during height resize", () => {
	for (const { chromeRows, name } of [
		{ chromeRows: 4, name: "short chrome baseline" },
		{ chromeRows: 22, name: "tall chrome above its resting floor" },
	]) {
		it(`keeps all table and text rows in scrollback or the viewport: ${name}`, async () => {
			const terminal = new VirtualTerminal(COLUMNS, 57);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true },
			});
			const transcript = new TranscriptContainer();
			const chrome = new LiveChrome();
			const editor = new Container();
			editor.addChild(new Text("EDITOR", 0, 0));
			composer.setRuntimeChildren([transcript, chrome, editor], {
				selfClearingChrome: [chrome],
				transientChrome: [editor],
			});
			composer.start({ playWelcomeIntro: false });
			try {
				await scheduler.settle(terminal);
				// Earlier settled output makes the native history/viewport seam relevant.
				transcript.addChild({ render: () => Array.from({ length: 40 }, (_, i) => `Earlier row ${i}`) });
				composer.setRunActive(true);
				chrome.rows = chromeRows;
				const message = new AssistantMessageComponent();
				message.updateContent(reply());
				message.markTranscriptBlockFinalized();
				transcript.addChild(message);
				composer.setRunActive(false);
				composer.ui.requestRender();
				await scheduler.advance(terminal, 300);
				expect(transcript.blockStates()).not.toContain("active");

				const snapshot = (stage: string) => ({
					stage,
					// getScrollBuffer is native scrollback followed by every active-grid row.
					reachable: markers(terminal.getScrollBuffer()),
					visible: markers(terminal.getViewport()),
				});
				const full = snapshot("57");
				expect(full.reachable).toEqual(EXPECTED);
				expect(full.visible).toEqual(EXPECTED);
				terminal.resize(COLUMNS, 28);
				await scheduler.advance(terminal, 300);
				const small = snapshot("28");
				terminal.resize(COLUMNS, 57);
				await scheduler.advance(terminal, 300);
				const grown = snapshot("57 again");

				for (const { reachable, visible } of [full, small, grown]) {
					// At the bottom, visible rows are the tail of the full native buffer.
					expect(reachable.slice(reachable.length - visible.length)).toEqual(visible);
				}
				expect([full, small, grown].map(({ stage, reachable }) => ({ stage, reachable }))).toEqual(
					["57", "28", "57 again"].map(stage => ({ stage, reachable: EXPECTED })),
				);
			} finally {
				composer.stop();
			}
		});
	}
});
