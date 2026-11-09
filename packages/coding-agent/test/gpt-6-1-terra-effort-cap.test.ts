import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { resolveTaskEffortLevel } from "@oh-my-pi/pi-tui/thinking";

// orb fork policy: GPT-6.1 Terra tops out at xhigh on every host, so `max` is
// never a supported effort and the `hi` task tier lands on xhigh. Codex rows
// are discovered live, so build them the way discovery does.
function discovered<TApi extends Api>(provider: string, api: TApi, id: string): ModelSpec<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

const terraRows: Array<[string, Model<Api>]> = [
	["openai-codex/gpt-6.1-terra", buildModel(discovered("openai-codex", "openai-codex-responses", "gpt-6.1-terra"))],
	[
		"openai-codex/gpt-6.1-terra-wm",
		buildModel(discovered("openai-codex", "openai-codex-responses", "gpt-6.1-terra-wm")),
	],
	["openai/gpt-6.1-terra (bundled)", getBundledModel("openai", "gpt-6.1-terra")],
	["openai/gpt-6.1-terra (rebuilt)", buildModel(discovered("openai", "openai-responses", "gpt-6.1-terra"))],
	[
		"openrouter/openai/gpt-6.1-terra",
		buildModel(discovered("openrouter", "openai-completions", "openai/gpt-6.1-terra")),
	],
	["factory-droid/gpt-6.1-terra", buildModel(discovered("factory-droid", "openai-responses", "gpt-6.1-terra"))],
];

describe("GPT-6.1 Terra effort cap", () => {
	for (const [label, terra] of terraRows) {
		test(`${label} tops out at xhigh`, () => {
			expect(terra).toBeDefined();
			const efforts = getSupportedEfforts(terra);
			expect(efforts.at(-1)).toBe(Effort.XHigh);
			expect(efforts).not.toContain(Effort.Max);
			expect(resolveTaskEffortLevel(terra, "hi")).toBe(Effort.XHigh);
		});
	}

	test("the cap does not leak onto GPT-6.1 Sol", () => {
		const sol = buildModel(discovered("openai-codex", "openai-codex-responses", "gpt-6.1-sol"));
		expect(getSupportedEfforts(sol).at(-1)).toBe(Effort.Max);
		expect(resolveTaskEffortLevel(sol, "hi")).toBe(Effort.Max);
	});

	test("other models keep their own top level", () => {
		const opus = getBundledModel("anthropic", "claude-opus-5-5");
		expect(opus).toBeDefined();
		const top = getSupportedEfforts(opus).at(-1);
		expect(top).toBe(Effort.Max);
		expect(resolveTaskEffortLevel(opus, "hi")).toBe(top);
	});
});
