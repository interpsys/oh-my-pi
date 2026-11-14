import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import {
	assertModelSupportsEffortCeiling,
	clampThinkingLevelToCeiling,
	modelSupportsEffortCeiling,
	resolveTaskEffortLevel,
} from "../src/thinking";

function customReasoner(): Model {
	return buildModel({
		id: "custom-reasoner",
		name: "custom-reasoner",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

const DEFERRED_LEVELS: Array<ThinkingLevel | undefined> = [undefined, ThinkingLevel.Inherit, ThinkingLevel.Off];

describe("clampThinkingLevelToCeiling", () => {
	it.each(DEFERRED_LEVELS)("preserves %s under a ceiling that clamps explicit efforts", level => {
		// Deferred selectors keep their documented meaning; the ceiling only applies to explicit efforts.
		expect(clampThinkingLevelToCeiling(customReasoner(), level, Effort.Low)).toBe(level);
	});

	it.each([undefined, Effort.Low, Effort.Max])("caps explicit efforts only when they exceed %s", ceiling => {
		const model = customReasoner();
		expect(clampThinkingLevelToCeiling(model, Effort.High, ceiling)).toBe(
			ceiling === Effort.Low ? Effort.Low : Effort.High,
		);
		expect(clampThinkingLevelToCeiling(model, Effort.Low, ceiling)).toBe(Effort.Low);
		expect(clampThinkingLevelToCeiling(undefined, Effort.High, ceiling)).toBe(
			ceiling === Effort.Low ? Effort.Low : Effort.High,
		);
	});

	it("clamps explicit efforts on unverified models", () => {
		const base = customReasoner();
		const model = { ...base, thinking: { ...base.thinking!, unverified: true } };
		expect(clampThinkingLevelToCeiling(model, Effort.High, Effort.Low)).toBe(Effort.Low);
	});

	it("snaps to the highest supported effort below the ceiling", () => {
		const base = customReasoner();
		const model = { ...base, thinking: { mode: "effort" as const, efforts: [Effort.Minimal, Effort.High] } };
		expect(clampThinkingLevelToCeiling(model, Effort.High, Effort.Low)).toBe(Effort.Minimal);
	});

	it("leaves incompatible floors unchanged for the caller to reject", () => {
		const model = customReasoner();
		expect(clampThinkingLevelToCeiling(model, Effort.High, Effort.Minimal)).toBe(Effort.High);
		expect(modelSupportsEffortCeiling(model, Effort.Minimal)).toBe(false);
		expect(modelSupportsEffortCeiling(model, Effort.Low)).toBe(true);
		expect(() => assertModelSupportsEffortCeiling(model, Effort.Minimal)).toThrow(
			"has no supported thinking effort at or below task.maxEffort=minimal",
		);
	});

	it("accepts models with no controllable effort surface", () => {
		const model = { ...customReasoner(), reasoning: false, thinking: undefined };
		expect(modelSupportsEffortCeiling(model, Effort.Minimal)).toBe(true);
	});
});

describe("resolveTaskEffortLevel", () => {
	it.each([Effort.Low, Effort.Medium, Effort.High, ThinkingLevel.Off, "auto" as const])(
		"preserves the configured default %s for med rather than selecting a midpoint",
		level => {
			expect(resolveTaskEffortLevel(customReasoner(), "med", undefined, level)).toBe(level);
		},
	);

	it("caps med's configured default and leaves endpoint mappings unchanged", () => {
		const model = customReasoner();
		expect(resolveTaskEffortLevel(model, "med", Effort.Low, Effort.High)).toBe(Effort.Low);
		expect(resolveTaskEffortLevel(model, "lo", undefined, Effort.High)).toBe(Effort.Low);
		expect(resolveTaskEffortLevel(model, "hi", undefined, Effort.Low)).toBe(Effort.High);
		expect(resolveTaskEffortLevel(model, "hi", Effort.Medium, Effort.Low)).toBe(Effort.Medium);
		expect(resolveTaskEffortLevel(undefined, "med", undefined, Effort.Low)).toBe(Effort.Low);
	});

	it("retains default fallback and rejects an incompatible ceiling", () => {
		expect(resolveTaskEffortLevel(customReasoner(), "med")).toBeUndefined();
		const model = { ...customReasoner(), reasoning: false, thinking: undefined };
		expect(resolveTaskEffortLevel(model, "med", undefined, Effort.High)).toBeUndefined();
		expect(() => resolveTaskEffortLevel(customReasoner(), "med", Effort.Minimal, Effort.High)).toThrow(
			"has no supported thinking effort at or below task.maxEffort=minimal",
		);
	});
});
