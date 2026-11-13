import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { DownloadActivity } from "@oh-my-pi/pi-coding-agent/downloads/activity";
import { DownloadActivityHud, JudgmentBatchProgressHud } from "@oh-my-pi/pi-coding-agent/modes/progress-hud";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

const plain = (lines: readonly string[]): string => lines.map(line => Bun.stripANSI(line).trim()).join("\n");

function activity(overrides: Partial<DownloadActivity>): DownloadActivity {
	return { id: 1, label: "SmolLM2-135M", state: "running", ...overrides };
}

describe("download HUD", () => {
	let clock = 1_000_000;
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function hudAt(start: number): DownloadActivityHud {
		clock = start;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		return new DownloadActivityHud(() => {});
	}

	it("never shows a download that finishes inside the reveal window", () => {
		const hud = hudAt(1_000_000);
		hud.update(activity({ loaded: 0, total: 100 }));
		clock += 50;
		hud.update(activity({ state: "done" }));
		clock += 500;

		expect(hud.render(100)).toEqual([]);
		hud.dispose();
	});

	it("shows byte progress for a download that outlasts the reveal window", () => {
		const hud = hudAt(1_000_000);
		hud.update(activity({ loaded: 0, total: 271_165_812, detail: "model.safetensors" }));
		expect(hud.render(100)).toEqual([]);

		clock += 200;
		hud.update(activity({ loaded: 135_582_906, total: 271_165_812, detail: "model.safetensors" }));
		const row = plain(hud.render(100));

		expect(row).toContain("SmolLM2-135M · model.safetensors");
		expect(row).toMatch(/129\.\d+MB \/ 258\.\d+MB$/);
		hud.dispose();
	});

	it("summarizes only revealed downloads and keeps failed work visible in the compact count", () => {
		const hud = hudAt(1_000_000);
		try {
			hud.update(activity({ id: 1 }));
			expect(hud.renderCompact(80)).toBeUndefined();
			clock += 200;
			hud.update(activity({ id: 2, state: "failed", error: "HTTP 403" }));
			hud.update(activity({ id: 3 }));
			const full = hud.render(80);
			expect(Bun.stripANSI(hud.renderCompact(80) ?? "")).toContain("2 downloads");
			expect(Bun.stripANSI(hud.renderCompact(80) ?? "")).toContain("1 failed");
			expect(Bun.stringWidth(hud.renderCompact(12) ?? "")).toBeLessThanOrEqual(12);
			expect(hud.render(80)).toEqual(full);
		} finally {
			hud.dispose();
		}
	});

	it("keeps a failure visible with its reason", () => {
		const hud = hudAt(1_000_000);
		hud.update(activity({ label: "Chromium", total: 150_000_000, loaded: 1 }));
		clock += 200;
		hud.update(activity({ label: "Chromium", state: "failed", error: "GET https://storage.googleapis.com: 403" }));
		clock += 5_000;

		expect(plain(hud.render(120))).toContain("Chromium failed: GET https://storage.googleapis.com: 403");
		hud.dispose();
	});
});

describe("judge batch compact HUD", () => {
	it("aggregates concurrent progress and failures instead of dropping a partially shown batch", () => {
		const hud = new JudgmentBatchProgressHud();
		expect(hud.renderCompact(80)).toBeUndefined();
		hud.update({ id: "a", intent: "First", done: 3, total: 10, failed: 1, cost: 0, running: true });
		hud.update({ id: "b", intent: "Second", done: 5, total: 5, failed: 2, cost: 0, running: false });
		const summary = Bun.stripANSI(hud.renderCompact(80) ?? "");
		expect(summary).toContain("2 judge batches");
		expect(summary).toContain("8/15");
		expect(summary).toContain("3 failed");
		expect(Bun.stringWidth(hud.renderCompact(12) ?? "")).toBeLessThanOrEqual(12);
		hud.delete("a");
		expect(Bun.stripANSI(hud.renderCompact(80) ?? "")).toContain("5/5");
		hud.clear();
		expect(hud.renderCompact(80)).toBeUndefined();
	});
});
