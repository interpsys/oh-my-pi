import { expect, it } from "bun:test";
import * as path from "node:path";
import { BUILD_INFO, BUILD_VERSION, VERSION } from "@oh-my-pi/pi-coding-agent";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { compileCodingAgent } from "../scripts/compile-binary";

const repoRoot = path.resolve(import.meta.dir, "../../..");

it("distinguishes source SDK provenance from a compiled fork revision without changing semver", () => {
	expect(BUILD_INFO).toEqual({ version: VERSION, commit: null, variant: "orb.1" });
	expect(VERSION).toBe("18.20.0");
	expect(BUILD_VERSION).toBe("18.20.0 (orb.1 source)");
});

it("embeds fork provenance independently of the runtime checkout and environment", async () => {
	using temp = TempDir.createSync("@omp-build-info-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	const buildInfoModule = path.join(repoRoot, "packages/coding-agent/src/build-info.ts");
	await Bun.write(
		entrypoint,
		`import { BUILD_INFO, BUILD_VERSION } from ${JSON.stringify(buildInfoModule)};\nconsole.log(JSON.stringify({ ...BUILD_INFO, display: BUILD_VERSION }));\n`,
	);
	const commit = (await $`git rev-parse HEAD`.cwd(repoRoot).quiet().text()).trim();
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		native: null,
	});
	const result = Bun.spawnSync([outfile], {
		cwd: temp.path(),
		env: { ...process.env, OMP_BUILD_COMMIT: "not-the-compiled-commit" },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString())).toEqual({
		version: "18.20.0",
		commit,
		variant: "orb.1",
		display: `18.20.0 (orb.1 ${commit.slice(0, 7)})`,
	});
}, 30_000);
