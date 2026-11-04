import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import type { Server } from "bun";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const TOKEN = "status-test-token";

function captureStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
}

async function runStatusJson(): Promise<Record<string, unknown>> {
	const output = captureStdout();
	try {
		await runAuthBrokerCommand({ action: "status", flags: { json: true } });
	} finally {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	}
	return JSON.parse(output().trim()) as Record<string, unknown>;
}

// Mirrors orbd's `/broker/*` front: every path, healthz included, needs the bearer.
function startBearerGatedBroker(): Server<undefined> {
	return Bun.serve({
		port: 0,
		fetch(req) {
			const header = req.headers.get("authorization");
			if (!header) {
				return Response.json(
					{ error: { code: "unauthenticated", message: "missing bearer token" } },
					{ status: 401 },
				);
			}
			if (header !== `Bearer ${TOKEN}`) {
				return Response.json(
					{ error: { code: "unauthenticated", message: "invalid or expired token" } },
					{ status: 401 },
				);
			}
			if (new URL(req.url).pathname === "/broker/v1/healthz") return Response.json({ ok: true, version: "9.9.9" });
			return new Response("not found", { status: 404 });
		},
	});
}

describe("omp auth-broker status", () => {
	let server: Server<undefined> | undefined;
	let savedExitCode: typeof process.exitCode;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		savedExitCode = process.exitCode;
		savedEnv.OMP_AUTH_BROKER_URL = process.env.OMP_AUTH_BROKER_URL;
		savedEnv.OMP_AUTH_BROKER_TOKEN = process.env.OMP_AUTH_BROKER_TOKEN;
		server = startBearerGatedBroker();
		process.env.OMP_AUTH_BROKER_URL = `http://127.0.0.1:${server.port}/broker`;
		process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
	});

	afterEach(() => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		server?.stop(true);
		server = undefined;
		process.exitCode = savedExitCode;
		for (const key of ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("reports ok against a broker that requires the bearer on healthz", async () => {
		const result = await runStatusJson();
		expect(result).toEqual({ url: process.env.OMP_AUTH_BROKER_URL, ok: true, version: "9.9.9" });
		expect(process.exitCode).toBe(savedExitCode);
	});

	test("reports a rejected token as auth_rejected with the broker's error code", async () => {
		process.env.OMP_AUTH_BROKER_TOKEN = "wrong-token";
		const result = await runStatusJson();
		expect(result).toMatchObject({
			ok: false,
			reason: "auth_rejected",
			status: 401,
			code: "unauthenticated",
		});
		expect(process.exitCode).toBe(1);
	});

	test("reports a broker that cannot be reached as unreachable", async () => {
		const port = server!.port;
		server!.stop(true);
		server = undefined;
		process.env.OMP_AUTH_BROKER_URL = `http://127.0.0.1:${port}/broker`;
		const result = await runStatusJson();
		expect(result).toMatchObject({ ok: false, reason: "unreachable" });
		expect(result.status).toBeUndefined();
		expect(process.exitCode).toBe(1);
	});
});
