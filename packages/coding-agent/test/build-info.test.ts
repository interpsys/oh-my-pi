import { expect, it } from "bun:test";
import { BUILD_INFO, BUILD_VERSION, VERSION } from "@oh-my-pi/pi-coding-agent";
import packageJson from "../package.json" with { type: "json" };

it("distinguishes source SDK provenance from a compiled fork revision without changing semver", () => {
	expect(BUILD_INFO).toEqual({ version: VERSION, commit: null, variant: "orb.7" });
	expect(VERSION).toBe(packageJson.version);
	expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	expect(BUILD_VERSION).toBe(`${packageJson.version} (orb.7 source)`);
});
