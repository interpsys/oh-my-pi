import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { openrouterModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { resolveTaskEffortLevel } from "@oh-my-pi/pi-tui/thinking";

// orb fork policy: every GPT Terra model tops out at xhigh on every host, so
// `max` is never a supported effort and the `hi` task tier lands on xhigh.
// Codex rows are discovered live, so build them the way discovery does.
function discovered<TApi extends Api>(
	provider: string,
	api: TApi,
	id: string,
	thinking?: ModelSpec<TApi>["thinking"],
): ModelSpec<TApi> {
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
		thinking,
	};
}

// What OpenRouter (and other discovery) advertises for Terra: an explicit
// ladder that reaches `max`. Explicit ladders win over rule ladders.
const advertisedMax = {
	mode: "effort" as const,
	efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	defaultLevel: Effort.Max,
};

function expectCapped(terra: Model<Api> | undefined): void {
	if (!terra) throw new Error("expected a Terra row");
	const efforts = getSupportedEfforts(terra);
	expect(efforts.at(-1)).toBe(Effort.XHigh);
	expect(efforts).not.toContain(Effort.Max);
	expect(terra.thinking?.defaultLevel).not.toBe(Effort.Max);
	expect(resolveTaskEffortLevel(terra, "hi")).toBe(Effort.XHigh);
}

const terraRows: Array<[string, () => Model<Api> | undefined]> = [
	[
		"openai-codex/gpt-6.1-terra",
		() => buildModel(discovered("openai-codex", "openai-codex-responses", "gpt-6.1-terra")),
	],
	[
		"openai-codex/gpt-6.1-terra-wm",
		() => buildModel(discovered("openai-codex", "openai-codex-responses", "gpt-6.1-terra-wm")),
	],
	[
		"openai-codex/gpt-5.6-terra",
		() => buildModel(discovered("openai-codex", "openai-codex-responses", "gpt-5.6-terra")),
	],
	["openai/gpt-6.1-terra (bundled)", () => getBundledModel("openai", "gpt-6.1-terra")],
	["openai/gpt-5.6-terra (bundled)", () => getBundledModel("openai", "gpt-5.6-terra")],
	["openai/gpt-5.6-terra-pro (bundled)", () => getBundledModel("openai", "gpt-5.6-terra-pro")],
	[
		"openrouter/openai/gpt-5.6-terra:batch (bundled)",
		() => getBundledModel("openrouter", "openai/gpt-5.6-terra:batch"),
	],
	["cursor/gpt-5.6-terra (bundled, collapsed tiers)", () => getBundledModel("cursor", "gpt-5.6-terra")],
	["openai/gpt-6.1-terra (rebuilt)", () => buildModel(discovered("openai", "openai-responses", "gpt-6.1-terra"))],
	[
		"openrouter/openai/gpt-6.1-terra",
		() => buildModel(discovered("openrouter", "openai-completions", "openai/gpt-6.1-terra")),
	],
	[
		"openrouter/openai/gpt-6.1-terra-pro:batch (advertises max)",
		() => buildModel(discovered("openrouter", "openai-completions", "openai/gpt-6.1-terra-pro:batch", advertisedMax)),
	],
	[
		"openrouter/~openai/gpt-terra-latest (advertises max)",
		() => buildModel(discovered("openrouter", "openai-completions", "~openai/gpt-terra-latest", advertisedMax)),
	],
	[
		"venice/openai-gpt-61-terra (advertises max)",
		() => buildModel(discovered("venice", "openai-completions", "openai-gpt-61-terra", advertisedMax)),
	],
	[
		"venice/openai-gpt-56-terra-pro (advertises max)",
		() => buildModel(discovered("venice", "openai-completions", "openai-gpt-56-terra-pro", advertisedMax)),
	],
	["factory-droid/gpt-6.1-terra", () => buildModel(discovered("factory-droid", "openai-responses", "gpt-6.1-terra"))],
];

// OpenRouter `/models` entries as served live: Terra advertises `max` in
// `reasoning.supported_efforts` (and as its default). Sol is the control.
function openRouterEntry(id: string) {
	return {
		id,
		name: id,
		supported_parameters: ["tools", "reasoning", "reasoning_effort"],
		architecture: { modality: "text+image->text" },
		pricing: { prompt: "0.000001", completion: "0.000005" },
		context_length: 1_050_000,
		top_provider: { max_completion_tokens: 128_000 },
		reasoning: { supported_efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "max" },
	};
}

const openRouterTerraIds = [
	"openai/gpt-6.1-terra",
	"openai/gpt-6.1-terra-pro:batch",
	"openai/gpt-5.6-terra",
	"openai/gpt-5.6-terra-pro",
	"~openai/gpt-terra-latest",
];

describe("GPT Terra effort cap", () => {
	for (const [label, terra] of terraRows) {
		test(`${label} tops out at xhigh`, () => {
			expectCapped(terra());
		});
	}

	test("OpenRouter discovery advertising max is capped through the merge and its cache", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-terra-effort-cap-"));
		const options = {
			...openrouterModelManagerOptions({
				fetch: async url =>
					String(url) !== "https://openrouter.ai/api/v1/models"
						? Response.json({ data: [] })
						: Response.json({ data: [...openRouterTerraIds, "openai/gpt-6.1-sol"].map(openRouterEntry) }),
			}),
			cacheDbPath: path.join(tempDir, "models.db"),
		};
		try {
			for (const strategy of ["online", "offline"] as const) {
				const { models } = await resolveProviderModels(options, strategy);
				for (const id of openRouterTerraIds) expectCapped(models.find(model => model.id === id));
				const sol = models.find(model => model.id === "openai/gpt-6.1-sol");
				if (!sol) throw new Error(`expected OpenRouter GPT-6.1 Sol (${strategy})`);
				expect(getSupportedEfforts(sol).at(-1)).toBe(Effort.Max);
				expect(resolveTaskEffortLevel(sol, "hi")).toBe(Effort.Max);
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

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
