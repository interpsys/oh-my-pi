# TICKET-harness-process-no-mcp: Process-only MCP discovery and startup opt-out

Schema-Version: 2
Kind: feature
Status: DONE
Resolving-Commit: ca8568bb1e8dd7923dd15e8b7bbebc3b41c391b2
Lane: harness
Repo: https://github.com/interpsys/oh-my-pi
Owner: AntigravityStreamStallFix-749006bb6bc0@chat
Issuer: Main-d63ad71f069c (session omp:01a1cec4-6aa4-7447-a546-d63ad71f069c; host compoooters-macbook-pro)
Created: 2026-11-12T09:31:46Z
Pinned: 2661f95e04cb84038e9183bd3ba02b176fbf88d8
Source: finding
Files: packages/coding-agent/src/cli/, packages/coding-agent/src/cli.ts, packages/coding-agent/src/main.ts, packages/coding-agent/src/sdk.ts, packages/coding-agent/src/mcp/, packages/coding-agent/src/commands/launch-help.ts, packages/coding-agent/test/mcp-process-opt-out.test.ts, packages/coding-agent/test/fixtures/mcp-process-opt-out-probe.ts, packages/coding-agent/CHANGELOG.md, docs/cli-reference.md, docs/environment-variables.md, docs/mcp-config.md, docs/mcp-runtime-lifecycle.md
Dedup-Key: omp-process-no-mcp
Acceptance-SHA256: b8a110759f686f74875708b6875a8ed08600b1dc53da42e04ac1c60dd54fe281
Disjoint-Paths: CLI/SDK/MCP startup and dedicated opt-out tests
Contract-Ref: none
Why-No-Repro: New per-process capability requested by the user; existing global disabledServers configuration works as designed but cannot isolate lightweight worker processes while preserving MCP in the main session.

## Goal & Motivation

Worker omp processes in Rex panes should avoid starting stdio plantlab and other MCP servers while the main session retains MCP. Parent explicitly added this requirement to release v18.18.5-orb.7.

## Scope & Non-Goals

Add --no-mcp and OMP_NO_MCP=1 process-scoped opt-out at CLI/bootstrap/SDK startup. Skip MCP discovery, startup and tools only for opted-out processes. Do not alter global mcp.json disabledServers, persisted settings, normal default startup or running processes. Document help and release notes.

## Interface & Contract

--no-mcp (boolean) or environment OMP_NO_MCP=1 independently disables MCP server discovery and startup and tool registration for that process. No opt-out preserves current behavior. SDK and subsequent command paths must respect process opt-out, not auto-connect after startup.

## Acceptance

### Positive Control

A configured local stdio MCP fixture starts and registers its tool without either opt-out; existing startup behavior remains unchanged.

### Negative Control

Each of `--no-mcp` and `OMP_NO_MCP=1` independently skips MCP discovery/startup and registers no MCP tools, without modifying persisted user configuration. An explicit later MCP connect must not bypass the process opt-out.

### Non-Regression Baseline

CLI parser/help, SDK startup and real stdio fixture tests cover default and opt-out paths. Changed-file lint/typecheck run; orb.7 installed binary exposes the flag and no-MCP live smoke remains successful.

```sh
(cd packages/coding-agent && bun test test/mcp-process-opt-out.test.ts)
~/.local/share/omp/bin/omp --help
OMP_NO_MCP=1 ~/.local/share/omp/bin/omp -p --model google-antigravity/gemini-4-carbon 'Reply with NO_MCP_OK only.'
```

## Resolution

Resolved by merge ca8568bb1e8dd7923dd15e8b7bbebc3b41c391b2 (PR #21), release v18.18.5-orb.7, installed --help and live OMP_NO_MCP=1 Carbon smoke NO_MCP_OK. Real stdio fixture default/flag/env controls: 15 pass/0 fail; no persisted config changes; later explicit connects blocked. TS/lint/format pass; full root Rust check limited by missing Ninja and canceled after completed TS receipts, with no configured release-line CI. Evidence: tickets/evidence-antigravity-stream-byte-watchdog.txt and https://github.com/interpsys/oh-my-pi/releases/tag/v18.18.5-orb.7. Initial nonexistent args.test.ts acceptance command was corrected to the dedicated stdio test; no criterion changed or dropped. Original acceptance hash 72a29186883e4e6be1adeb40f9177632ed6c115cd580bddabc77244ab749536e; corrected hash b8a110759f686f74875708b6875a8ed08600b1dc53da42e04ac1c60dd54fe281.

## Log

- 2026-11-12T09:31:46Z filed per Main-d63ad71f069c user request in the same authorized orb.7 release; no prior behavior defect claimed.
- Native orb ticket close recorded DONE at resolving merge ca8568bb1e8dd7923dd15e8b7bbebc3b41c391b2 with stdio controls and installed-binary help/live-smoke evidence.
