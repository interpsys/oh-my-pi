# TICKET-harness-antigravity-stream-byte-watchdog: Abort and retry silent Cloud Code Assist streams

Schema-Version: 2
Kind: defect
Status: IN_PROGRESS
Lane: harness
Repo: https://github.com/interpsys/oh-my-pi
Owner: AntigravityStreamStallFix-749006bb6bc0@chat
Issuer: Main-d63ad71f069c (session omp:01a1cec4-6aa4-7447-a546-d63ad71f069c; host compoooters-macbook-pro)
Created: 2026-11-12T09:20:00Z
Pinned: 2661f95e04cb84038e9183bd3ba02b176fbf88d8
Source: finding
Files: packages/ai/src/providers/google-gemini-cli.ts, packages/ai/src/providers/register-builtins.ts, packages/ai/src/utils/stream-byte-watchdog.ts, packages/utils/src/stream.ts, packages/ai/test/google-gemini-cli-byte-watchdog.test.ts, packages/ai/test/google-gemini-cli-first-event-timeout.test.ts, packages/ai/test/google-empty-response-retry.test.ts, packages/coding-agent/src/session/turn-recovery.ts, packages/coding-agent/test/agent-session-retry-fallback.test.ts, packages/coding-agent/src/build-info.ts, packages/coding-agent/test/build-info.test.ts, docs/provider-quirks.md, docs/non-compaction-retry-policy.md, packages/ai/CHANGELOG.md, packages/coding-agent/CHANGELOG.md, packages/coding-agent/src/session/settings.ts
Dedup-Key: omp-antigravity-silent-stream-byte-watchdog
Acceptance-SHA256: 4a51ffb22f929107401b6620eaebe9cf6397a2b7966efcb5ec765701f6b6542c
Blast-Radius: google-gemini-cli and google-antigravity streaming requests, coding-agent timeout settings, installed Darwin arm64 omp

## Symptom & Impact

Observed: a fully uploaded Gemini/Antigravity request can produce no surfaced output until Escape; separate raw replies and same-body resends have not been captured during a failing live turn. Expected: raw response-byte silence is bounded by configurable first-byte and idle deadlines (defaults 300 s; parent-approved after observing legitimate 146 s TTFT), aborts the active transport, and retries with a fresh connection, preferring the alternate endpoint. Empty output must surface after bounded unchanged-body retries, then enter visible capped same-model continuation. Thinking, comments and partial SSE frames count as traffic.

## Reproduction & Controls

### Failing Case (Before)

Portable real-local-server reproduction is packages/ai/test/google-gemini-cli-byte-watchdog.test.ts. Executed against the original provider fetched with `git show 2661f95e:packages/ai/src/providers/google-gemini-cli.ts` into a temporary sibling module; the test import alone pointed to that original module. Result: 1 pass (caller cancellation), 5 fail: headerless requests surfaced \"Request was aborted\" instead of retrying; body-stall retry reused pooling; continuous partial bytes incorrectly triggered failover; thinking stall exceeded 5-second test safety. Before output: artifact://363, preserved in tickets/evidence-antigravity-stream-byte-watchdog.txt. Temporary baseline module/test were removed.

```sh
bun test packages/ai/test/google-gemini-cli-byte-watchdog.test.ts
```

### Known-Good Control

Continuously arriving body bytes, including partial SSE and thinking-only traffic, must not be aborted merely because total duration exceeds the first-byte timeout. Caller abort must remain aborted without endpoint retry. Existing empty-response and first-event failover tests must continue passing.

```sh
bun test packages/ai/test/google-gemini-cli-first-event-timeout.test.ts packages/ai/test/google-empty-response-retry.test.ts
```

## Provenance

PR #14 (8689c546499acbf27978b7a33dc86c2d96057dd7, based on orb/v18.16.0) fixed exhausted empty-response retry multiplication and diagnostics, not missing response bytes. Release line contains fdfe4bf337 with corresponding subject and subsequent b91fab53ed same-model recovery. [UNOBSERVED: checked PR #14, release provider and timeout helpers; unavailable decisive original introduction and author rationale for byte-level stalls.] Runtime source of silence (sandbox fault, stale connection, per-request server stall) remains unproven; fix covers those failure modes without asserting cause.

## Acceptance

1. Real local fake-server tests prove headerless timeout, body silence, automatic alternate-endpoint retry on fresh connection, single-endpoint retry, bounded idle after thinking, slow continuous bytes, and caller cancellation.
2. Existing settings providers.streamFirstEventTimeoutSeconds and providers.streamIdleTimeoutSeconds retain override/disable behavior; provider defaults both 300 seconds (Main explicitly superseded the original 120-second requirement after observing legitimate 146-second TTFT). Every timeout logs endpoint and elapsed gap.
3. Changed-file lint/format and typechecks run; repository CI receipt or concrete limitation recorded.
4. Merge to orb/v18.18.5 and release v18.18.5-orb.7 (or documented existing manual-build pattern); install with rollback binary/manifest and exact SHA256 in manager.json. Verify installed --version and checksum.
5. Live installed-binary short prompt google-antigravity/gemini-4-carbon works. Do not restart running omp processes; return restart command to parent.
6. Empty STOP retries send at most one unchanged request per endpoint, then surface error into bounded same-model continuation that changes the prompt. Fake-server test returns empty STOP until the continuation changes the body; recovery succeeds without manual resend. Every resend logs reason, endpoint, attempt, elapsed time, response bytes and finish reason where available; session continuations emit visible retry events.

```sh
bun test packages/ai/test/google-gemini-cli-byte-watchdog.test.ts packages/ai/test/google-gemini-cli-first-event-timeout.test.ts packages/ai/test/google-empty-response-retry.test.ts
bun check
~/.local/share/omp/bin/omp --version
shasum -a 256 ~/.local/share/omp/bin/omp
~/.local/share/omp/bin/omp -p --model google-antigravity/gemini-4-carbon 'Reply with WATCHDOG_OK only.'
```

## Resolution

Implementation in progress. Resolving SHA and empirical evidence will be recorded by native ticket closure. Scope change approved by Main-d63ad71f069c in-session at 2026-11-12T09:20Z: defaults 120→300s to preserve observed146s cold starts; additionally bound/log empty STOP retries and expose changed-prompt continuation. Original acceptance hash 2691fe4e214e62fbb12790407e599d76a1af5f163de19bff294f559e523dc706; amended hash 4a51ffb22f929107401b6620eaebe9cf6397a2b7966efcb5ec765701f6b6542c. No scope was deferred.

## Log

- 2026-11-12T09:20:00Z filed AntigravityStreamStallFix-749006bb6bc0 omp:01a1cf06-a70b-72e2-94ef-749006bb6bc0 Issuer Main-d63ad71f069c; portable repro and byte watchdog implementation assigned.
- Parent wire evidence: production and a fresh connection also hung; sandbox-only and fresh-connection-only explanations refuted. Three same-connection uploads fit initial+two identical-body empty retries, but the incident's actual ~4KB response frames remain unobserved (203 dump files, none in incident window).
- Isolated substantive high-thinking copied-session baseline probe (2026-11-12T09:25:39Z..09:27:51Z) succeeded in one production request: first bytes21.897s, first answer108.420s, body96058bytes/98frames, end128.959s, exit0. Terminal signature-only STOP followed real thinking/text; no empty STOP reproduced. Evidence: /Users/compoooter/tmp/antigravity-watchdog-artifacts/carbon-wire.jsonl and carbon-run-receipt.json.
