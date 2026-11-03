import { expect, it } from "bun:test";
import { BUILD_INFO, BUILD_VERSION, VERSION } from "@oh-my-pi/pi-coding-agent";

it("distinguishes source SDK provenance from a compiled fork revision without changing semver", () => {
	expect(BUILD_INFO).toEqual({ version: VERSION, commit: null, variant: "orb.1" });
	expect(VERSION).toBe("18.16.0");
	expect(BUILD_VERSION).toBe("18.16.0 (orb.1 source)");
});
