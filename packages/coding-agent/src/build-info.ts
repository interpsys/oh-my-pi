import { VERSION } from "@oh-my-pi/pi-utils/dirs";

// Replaced by compileCodingAgent, not read from the environment or the runtime cwd.
declare const __OMP_BUILD_COMMIT__: string | undefined;

/** Fork provenance of this executable; source invocations have no compiled commit. */
export const BUILD_INFO: Readonly<{ version: string; commit: string | null; variant: string }> = Object.freeze({
	version: VERSION,
	commit: typeof __OMP_BUILD_COMMIT__ === "undefined" ? null : __OMP_BUILD_COMMIT__,
	variant: "orb.8",
});

/** Display version; VERSION remains the upstream semver for compatibility checks. */
export const BUILD_VERSION = `${BUILD_INFO.version} (${BUILD_INFO.variant} ${BUILD_INFO.commit?.slice(0, 7) ?? "source"})`;
