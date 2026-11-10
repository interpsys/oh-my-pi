import { describe, expect, test } from "bun:test";
import { Effort } from "../src/effort";
import { getSupportedEfforts } from "../src/model-thinking";
import { getBundledModel } from "../src/models";

// Brokered hosts (orb boxes) never run Antigravity discovery: a model reachable there must be bundled, or
// `google-antigravity/gemini-4-carbon` falls through to another provider's namespaced gateway row.
describe("bundled Google Antigravity Gemini 4 Carbon", () => {
	const carbon = getBundledModel("google-antigravity", "gemini-4-carbon");

	test("is one collapsed row routing each thinking level to its SKU", () => {
		expect(carbon).toBeDefined();
		expect(getSupportedEfforts(carbon!)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(Object.keys(carbon!.antigravityWireProfiles ?? {}).sort()).toEqual([
			"gemini-4-carbon-high",
			"gemini-4-carbon-low",
			"gemini-4-carbon-medium",
		]);
		for (const tier of ["low", "medium", "high"] as const) {
			expect(getBundledModel("google-antigravity", `gemini-4-carbon-${tier}`)).toBeUndefined();
		}
	});

	test("carries Google's introductory price", () => {
		expect(carbon!.cost).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 });
	});
});
