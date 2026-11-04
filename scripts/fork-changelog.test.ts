import { expect, it } from "bun:test";
import * as path from "node:path";

const forkNotes = [
	{ package: "ai", notes: ["tool calls served through the Anthropic auth gateway losing their inputs"] },
	{
		package: "coding-agent",
		notes: [
			"Eval `tool.mcp__<server>_<tool>(...)`",
			"Python eval `b = await judge_batch(...)`",
			"Python eval cells compile as `<cell-N>`",
			"The native judgment answer cache (`~/.omp/cache/judgment-cache.db`) is capped",
		],
	},
	{
		package: "tui",
		notes: [
			"Native Rex sessions, including `TERM=xterm-rex`",
			"Rex charts now use Unicode placeholders",
			"completed table and reply rows disappearing on short terminals",
		],
	},
];

for (const { package: packageName, notes } of forkNotes) {
	it(`${packageName} attributes fork changes to Unreleased rather than historical upstream releases`, async () => {
		const text = await Bun.file(path.join(import.meta.dir, "..", "packages", packageName, "CHANGELOG.md")).text();
		const releases = text.split(/(?=^## \[)/m);
		const unreleased = releases.find(section => section.startsWith("## [Unreleased]"));
		expect(unreleased).toBeDefined();
		for (const note of notes) {
			expect(unreleased).toContain(note);
			expect(text.split(note)).toHaveLength(2);
		}
		const upstream = releases.find(section => section.startsWith("## [18.14.2]"));
		expect(upstream).toBeDefined();
		for (const section of [unreleased!, upstream!]) {
			const headings = [...section.matchAll(/^### (.+)$/gm)].map(match => match[1]);
			expect(headings).toEqual([...new Set(headings)]);
		}
	});
}
