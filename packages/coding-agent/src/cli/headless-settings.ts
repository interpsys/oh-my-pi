/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { DEFAULT_HEADLESS_MAX_CONCURRENT, validateHeadlessMaxConcurrent } from "./headless-gate";

/**
 * Machine-wide cap on concurrent headless runs (`-p`, `--mode text|json`, non-terminal stdin),
 * enforced at launch by `./headless-gate`; `OMP_HEADLESS_SLOTS` can only lower it.
 */
export const cfgHeadlessMaxConcurrent = register({
	id: "headless.maxConcurrent",
	type: "number",
	default: DEFAULT_HEADLESS_MAX_CONCURRENT,
	validate: validateHeadlessMaxConcurrent,
});
