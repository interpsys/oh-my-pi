import { beforeAll, describe, expect, it } from "bun:test";
import { type Component, Container } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer, type CompactChrome } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

class Rows implements Component {
	constructor(
		readonly label: string,
		public count: number,
	) {}

	render(): readonly string[] {
		return Array.from({ length: this.count }, (_, row) => `${this.label} ${row}`);
	}
}

class LiveTranscript extends Rows {
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
}

class ClickableHud extends Rows implements CompactChrome {
	renders = 0;

	override render(): readonly string[] {
		this.renders++;
		return super.render();
	}

	renderCompact(): string {
		return `${this.label}: ${this.count} agents`;
	}

	getClickAgentAtRow(row: number): string | undefined {
		return row >= 0 && row < this.count ? `${this.label}-${row}` : undefined;
	}
}

function makeHarness(
	transcriptRows: number,
	below: readonly Component[],
	selfClearing: readonly Component[],
	completeScrollback = false,
) {
	const terminal = new VirtualTerminal(100, 40);
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: new VirtualRenderScheduler() },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, completeScrollback },
	});
	const transcript = new TranscriptContainer();
	transcript.addChild(new LiveTranscript("Transcript", transcriptRows));
	const editor = new Container();
	editor.addChild({ render: () => ["EDITOR"] });
	composer.setRuntimeChildren([transcript, ...below, editor], {
		selfClearingChrome: selfClearing,
		transientChrome: [editor],
	});
	composer.start({ playWelcomeIntro: false });
	return { composer, transcript, editor };
}

function transcriptRows(rows: readonly string[]): string[] {
	return rows.filter(row => row.startsWith("Transcript "));
}

beforeAll(async () => {
	await initTheme();
});

describe("self-clearing chrome height pressure", () => {
	it("restores whole HUDs after compact and hidden frames without stale click rows or rowsBelow", () => {
		const anchor = new Rows("Anchor", 1);
		const hud = new ClickableHud("Workers", 8);
		const root = new Container();
		root.addChild(hud);
		const control = new ClickableHud("Control", 1);
		const { composer } = makeHarness(5, [anchor, root, control], [root]);
		try {
			const frame = (rows: number): readonly string[] => {
				const before = hud.renders;
				const viewport = composer.renderFrame({ columns: 100, rows }).viewport;
				expect(hud.renders - before).toBe(1);
				expect(transcriptRows(viewport)).toEqual(Array.from({ length: 5 }, (_, row) => `Transcript ${row}`));
				expect(viewport.at(-1)).toBe("EDITOR");
				expect(composer.viewportClickCandidates(viewport.indexOf("Control 0"))).toEqual(["Control-0"]);
				return viewport;
			};
			const full = frame(20);
			for (let row = 0; row < 8; row++) {
				expect(composer.viewportClickCandidates(full.indexOf(`Workers ${row}`))).toEqual([`Workers-${row}`]);
			}
			expect(composer.rowsBelow(anchor)).toBe(10);

			const compact = frame(10);
			expect(compact).toContain("Workers: 8 agents");
			expect(compact.some(row => row.startsWith("Workers "))).toBe(false);
			expect(composer.viewportClickCandidates(compact.indexOf("Workers: 8 agents"))).toEqual([]);
			expect(composer.rowsBelow(anchor)).toBe(3);
			expect(composer.rowsBelow(root)).toBe(2);
			expect(frame(10)).toEqual(compact);

			const hidden = frame(8);
			expect(hidden.some(row => row.startsWith("Workers"))).toBe(false);
			expect(composer.rowsBelow(anchor)).toBe(2);
			expect(frame(8)).toEqual(hidden);
			expect(frame(10)).toEqual(compact);
			expect(frame(20)).toEqual(full);
			for (let row = 0; row < 8; row++) {
				expect(composer.viewportClickCandidates(full.indexOf(`Workers ${row}`))).toEqual([`Workers-${row}`]);
			}
		} finally {
			composer.stop();
		}
	});

	it("reserves multiple HUD summaries before expanding whole roots and never cuts a notice in half", () => {
		const todos = new ClickableHud("Todos", 6);
		const agents = new ClickableHud("Agents", 5);
		const notice = new Rows("Notice", 4);
		const { composer } = makeHarness(4, [todos, agents, notice], [todos, agents, notice]);
		try {
			const compact = composer.renderFrame({ columns: 100, rows: 8 }).viewport;
			expect(compact).toContain("Todos: 6 agents");
			expect(compact).toContain("Agents: 5 agents");
			expect(compact.some(row => row.startsWith("Notice"))).toBe(false);
			expect(transcriptRows(compact)).toEqual(Array.from({ length: 4 }, (_, row) => `Transcript ${row}`));
			expect(composer.renderFrame({ columns: 100, rows: 8 }).viewport).toEqual(compact);

			const expanded = composer.renderFrame({ columns: 100, rows: 13 }).viewport;
			expect(expanded.filter(row => row.startsWith("Todos "))).toHaveLength(6);
			expect(expanded).toContain("Agents: 5 agents");
			expect(expanded.some(row => row.startsWith("Notice"))).toBe(false);
			expect(composer.renderFrame({ columns: 100, rows: 13 }).viewport).toEqual(expanded);

			const full = composer.renderFrame({ columns: 100, rows: 24 }).viewport;
			expect(full.filter(row => row.startsWith("Agents "))).toHaveLength(5);
			expect(full.filter(row => row.startsWith("Notice "))).toEqual([
				"Notice 0",
				"Notice 1",
				"Notice 2",
				"Notice 3",
			]);
			expect(full.at(-1)).toBe("EDITOR");
		} finally {
			composer.stop();
		}
	});

	it("omits a HUD taller than the viewport when the transcript uses every spare row", () => {
		const hud = new ClickableHud("Workers", 50);
		const { composer } = makeHarness(20, [hud], [hud]);
		try {
			const fullTail = Array.from({ length: 11 }, (_, row) => `Transcript ${row + 9}`);
			const small = composer.renderFrame({ columns: 100, rows: 12 }).viewport;
			expect(small).toEqual([...fullTail, "EDITOR"]);
			for (let row = 0; row < small.length; row++) expect(composer.viewportClickCandidates(row)).toEqual([]);
			expect(composer.renderFrame({ columns: 100, rows: 12 }).viewport).toEqual(small);
			const grown = composer.renderFrame({ columns: 100, rows: 80 }).viewport;
			expect(transcriptRows(grown)).toHaveLength(20);
			expect(grown.filter(row => row.startsWith("Workers "))).toHaveLength(50);
			expect(grown.at(-1)).toBe("EDITOR");
		} finally {
			composer.stop();
		}
	});

	it("keeps draft and dialog rows intact while they retain their existing transient floor", () => {
		const hud = new ClickableHud("Workers", 6);
		const { composer, editor } = makeHarness(5, [hud], [hud]);
		const draft = new Rows("Draft", 10);
		try {
			const initial = composer.renderFrame({ columns: 100, rows: 12 }).viewport;
			expect(initial.filter(row => row.startsWith("Workers "))).toHaveLength(6);
			editor.clear();
			editor.addChild(draft);
			const expanded = composer.renderFrame({ columns: 100, rows: 12 }).viewport;
			expect(expanded.filter(row => row.startsWith("Draft "))).toEqual([...draft.render()]);
			expect(expanded.some(row => row.startsWith("Workers"))).toBe(false);
			// A user-opened surface still covers the live tail rather than retiring it.
			expect(transcriptRows(expanded)).toEqual(["Transcript 3", "Transcript 4"]);
			editor.clear();
			editor.addChild({ render: () => ["EDITOR"] });
			expect(composer.renderFrame({ columns: 100, rows: 12 }).viewport).toEqual(initial);
		} finally {
			composer.stop();
		}
	});

	it("leaves completeScrollback's full HUD layout unchanged", () => {
		const hud = new ClickableHud("Workers", 8);
		const { composer } = makeHarness(5, [hud], [hud], true);
		try {
			const viewport = composer.renderFrame({ columns: 100, rows: 10 }).viewport;
			expect(transcriptRows(viewport)).toEqual(["Transcript 4"]);
			expect(viewport.filter(row => row.startsWith("Workers "))).toHaveLength(8);
			expect(viewport).not.toContain("Workers: 8 agents");
			expect(viewport.at(-1)).toBe("EDITOR");
		} finally {
			composer.stop();
		}
	});

	it("yields resize-buffer HUD rows without changing transcript lifecycle or trimming input", () => {
		const hud = new ClickableHud("Workers", 8);
		const { composer, transcript } = makeHarness(10, [hud], [hud]);
		try {
			composer.renderFrame({ columns: 100, rows: 40 });
			const states = transcript.blockStates();
			const compact = composer.renderResizeFrame({ columns: 100, rows: 12 });
			expect(transcriptRows(compact)).toEqual(Array.from({ length: 10 }, (_, row) => `Transcript ${row}`));
			expect(compact).toContain("Workers: 8 agents");
			expect(compact.at(-1)).toBe("EDITOR");
			const hidden = composer.renderResizeFrame({ columns: 100, rows: 8 });
			expect(hidden).toEqual([...Array.from({ length: 7 }, (_, row) => `Transcript ${row + 3}`), "EDITOR"]);
			const grown = composer.renderResizeFrame({ columns: 100, rows: 20 });
			expect(grown.filter(row => row.startsWith("Workers "))).toHaveLength(8);
			expect(transcript.blockStates()).toEqual(states);
		} finally {
			composer.stop();
		}
	});
});
