# TICKET-harness-antigravity-official-request-parity: Gate official Gemini request encoding and compare real failing states

Schema-Version: 2
Kind: feature
Status: OPEN
Lane: harness
Repo: interpsys/oh-my-pi
Owner: CarbonOfficialParity-81556c038d06@chat
Issuer: Main-d63ad71f069c (session omp:01a1cec4-6aa4-7447-a546-d63ad71f069c; host compoooters-macbook-pro)
Created: 2026-11-12T18:38:00Z
Pinned: ca8568bb1e8dd7923dd15e8b7bbebc3b41c391b2
Source: finding:/Users/compoooter/tmp/workers/wire-capture-official/RESULT.md
Files: packages/ai/src/providers/google-gemini-cli.ts, packages/ai/src/providers/google-shared.ts, packages/ai/src/types.ts, packages/ai/test/, packages/coding-agent/src/config/, packages/coding-agent/src/, packages/coding-agent/test/, packages/ai/CHANGELOG.md, packages/coding-agent/CHANGELOG.md, docs/, tickets/
Dedup-Key: antigravity-official-request-parity-2312
Acceptance-SHA256: f6dca86d94f3896eadb6c00f1a450de8c68fa1aa0e267cbd704ea3050468581c
Disjoint-Paths: provider encoding and related provider option/setting plumbing and tests
Contract-Ref: /Users/compoooter/tmp/workers/wire-capture-official/RESULT.md
Why-No-Repro: This adds an opt-in alternate wire contract; current signature suppression was an intentional workaround, not a violated existing official-parity invariant. Empty and generic 400 failures are stochastic even on identical bodies; the paired experiment tests improvement rather than claiming a deterministic cure.

## Goal & Motivation

Align Antigravity Gemini requests with four live official 2.31.2 captures while preserving a baseline setting for comparison. Prior evidence: wire-capture-official, replay-400-mutations, official-empty-fix, account-endpoint-health, fork-history RESULT.md files under /Users/compoooter/tmp/workers and heartbeat-top-pane/THESES.md. No account or endpoint degradation was demonstrated on short controls. Parser thought-first/gap controls passed.

## Scope & Non-Goals

Implement providers.antigravityRequestParity on/off and propagate it into provider options. For Gemini Antigravity only: retain real text/tool signatures across turns; use the bypass sentinel only for absent real signatures; include matching function-call/response ids and official separate model-role functionResponse placement; requestType agent; omit toolConfig; separate declarations and official schema encoding. Redacted captured-body unit fixtures establish field parity, normalizing only volatile request/session identity. Preserve existing public Gemini, Gemini CLI, and Antigravity Claude encoding. Do not change output cap, thinking level, parser, retry policy or running processes.

## Interface & Contract

Setting is default-off until preregistered A/B passes; off preserves orb.7 encoding. A/B uses 3–5 actual failure states from sessions 01a1d0b4 and 01a1cf34, >=20 trials per arm/state, interleaved on one account and daily endpoint, complete SSE consumption, <=400 physical requests including controls/smokes. Never print credentials. Report empty/400/ok counts and Wilson 95% CIs per cell, all assigned trials including transport failures. Freeze manifest, order, definitions and shipping rule before any A/B request. Enable by default only with noninferiority on both failure types and CI-backed or clear benefit on >=1; inconclusive means default-off. Release v18.18.5-orb.8 and install with rollback backup/manifest and verified binary SHA256; do not restart existing processes.

## Acceptance

### Positive Control

```sh
bun test packages/ai/test/google-antigravity-request-parity.test.ts
# parity-on matches redacted official bodies including signatures, role, IDs, schemas, tool packing and missing toolConfig.
```

### Negative Control

```sh
bun test packages/ai/test/google-antigravity-request-parity.test.ts
# parity-off retains baseline; non-Antigravity Gemini/CLI and Antigravity Claude are unchanged.
```

### Non-Regression Baseline

```sh
bun test packages/ai/test/google-gemini-cli*.test.ts packages/ai/test/google-shared*.test.ts
bun check
# scoped changed-file format/lint/typechecks and applicable CI, with environmental limitations recorded.
```

Run the frozen real-state A/B, retain per-request sanitized ledger and per-state/arm table with Wilson CIs, decision and manifest reconciliation. Ship merged release v18.18.5-orb.8, record tag/commit, installed binary SHA256, rollback path, settings behavior, live smoke and exact restart command without executing it. Close native ticket with exact pushed resolving SHA and evidence.

Hydrogen scope addition (issuer instruction 2026-11-12T18:53Z): the same parity path must apply to Antigravity Gemini4 Hydrogen. Add Hydrogen-high on D-EMPTY-EARLY and one400 state,20 trials per arm/state (80 additional; planned combined280+controls, still<=400), report separately from Carbon. Preserve true historical model attribution: Carbon signatures are not relabeled as Hydrogen signatures. Unit tests prove continuity on actual same-model Hydrogen histories, and live controls exercise a fresh Hydrogen tool/signature continuation.

## Provenance

Intentional signature suppression: original 224b48fd1d, fork PR #5 merge 36dcda4ee876, later cherry-pick aafe69dabe; ArgonInvalidArgFix-902bb8d64061 session 01a1a501-647f-7118-8111-902bb8d64061 reported nine transformed-dump HTTP200 outcomes and explicitly had not tested a patched serializer. Source: fork-history/RESULT.md lines 51–52 and replay-400-mutations/RESULT.md lines 79–82. No deterministic Carbon causal claim follows. Full introducing SHAs beyond cited pinned evidence are unobserved in this feature filing.

Request-type omission provenance: f1fb41a9687191114be4a407b16c9fdcfb761027 (2026-09-12T17:22:05-03:00), UNATTRIBUTED (git author João C. Furtado). Stated reason: \"Fixes false HTTP 429 RESOURCE_EXHAUSTED when system instructions contain RFC 2119 keywords\" (commit body, Fixes #11809). That commit claimed omission matched the then-official client; four live 2.31.2 captures now include agent. A/B retains HTTP429 separately per arm/state and treats all other failures as guardrail failures; no quota-bypass behavior is introduced.

## Resolution

Pending implementation, A/B and deployment; no resolving commit yet.

## Log

- 2026-11-12T18:38:00Z filed CarbonOfficialParity-81556c038d06 01a1d10a-9862-762d-8565-81556c038d06 official encoding feature and bounded comparison.
- 2026-11-12T18:53:00Z scope_change Main-d63ad71f069c omp:01a1cec4-6aa4-7447-a546-d63ad71f069c adds Hydrogen parity and80 live comparison trials; original Carbon scope retained, no deferred requirements.
- Scope-Change: old_sha256=36c013413d1fbc5ba4439b6193122b5325f064d01161280f2464e06a1c806d26; new_sha256=f6dca86d94f3896eadb6c00f1a450de8c68fa1aa0e267cbd704ea3050468581c; owner=Main-d63ad71f069c (omp:01a1cec4-6aa4-7447-a546-d63ad71f069c); reason=user Hydrogen coverage addition before first experiment; Dropped-Scope-Ticket: none.
