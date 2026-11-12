# TICKET-harness-antigravity-timeout-escalation: Bound identical timeout requests per endpoint

Schema-Version: 2
Kind: defect
Status: DONE
Lane: harness
Repo: interpsys/oh-my-pi
Owner: CarbonOfficialParity-81556c038d06@chat
Issuer: Main-d63ad71f069c (session omp:01a1cec4-6aa4-7447-a546-d63ad71f069c; host compoooters-macbook-pro)
Created: 2026-11-12T19:00:00Z
Pinned: ca8568bb1e8dd7923dd15e8b7bbebc3b41c391b2
Source: finding:parent-live-session-01a1d0b4-20261112T1851Z
Files: packages/ai/src/providers/google-gemini-cli.ts, packages/ai/test/google-gemini-cli-byte-watchdog.test.ts, packages/utils/src/fetch-retry.ts, packages/utils/test/fetch-retry.test.ts, packages/{ai,utils}/CHANGELOG.md, docs/provider-quirks.md, tickets/
Dedup-Key: antigravity-byte-timeout-identical-escalation
Acceptance-SHA256: 6e08dd76a1048c177d64e9a1bc91d0603c6815bd1041f2c8f3b96d3234623af4
Blast-Radius: Cloud Code Assist chat first-byte and idle timeout requests, google-antigravity and google-gemini-cli, installed omp
Intro-Commit: cd8ce85de0f431cdccaa975a4870cea0e72fbdf9
Intro-Author: AntigravityStreamStallFix-749006bb6bc0
Intro-Reason: "fix: bound Antigravity stream recovery and add process MCP opt-out"; commit body has only attribution trailer, so no narrower author rationale is available. The changed watchdog signal ownership exposed generic fetch retries and added endpoint cycling; the installed docs explicitly said a single/pinned endpoint retries itself.

## Symptom & Impact

User-observed session01a1d0b4 on orb.7, fixed window[2026-11-12T18:51:00Z,2026-11-12T18:59:00Z): with both global byte budgets90s, one turn logged identical-body retries at elapsed90s,181s,273s,367s rather than escalating. Four observed retries in one supplied episode; fleet exposure denominator unavailable. User report is ground truth, not rerun for confirmation. Expected at most one timeout request per endpoint then changed-prompt continuation or fallback, as empty-response exhaustion does.

## Reproduction & Controls

### Failing Case (Before)

Executed portable fake CCA server before fix: silent headers/body on all endpoints produced 5 requests (daily + sandbox x4), body silence produced 4, mixed silence produced 6; pinned production produced 4. Command and raw before receipt: /tmp/timeout-escalation-receipts/before.txt (8 pass,6 fail). User's live episode was not resent. A strengthened emitted-thinking/text control separately failed 0 pass,2 fail (error remained retryable), receipt checks/post-output-before.txt.

### Known-Good Control

Existing byte-watchdog fake-server controls: trickling raw bytes/comments survive longer than budgets; one stalled endpoint recovers on alternate fresh connection; caller abort and already-emitted output never replay. Add explicit fixed-endpoint exhaustion control plus session-level escalation mapping.

## Provenance

Pinned provider fetchResponse delegates pre-header StreamTimeoutError to generic fetchWithRetry; final endpoint gets MAX_RETRIES+1 and catch can append the first endpoint while total attempts<4. Commit cd8ce85de0f431cdccaa975a4870cea0e72fbdf9 moved watchdog cancellation from fetchWithRetry's signal into the per-attempt fetch override and added endpoint cycling. Earlier 0386d44fec (can1357, 2026-06-18, "refactor(ai): replaced abort signal timeouts with clearable fetch timers") already allowed four HTTP/network attempts, but watchdog cancellation then ended that loop. [INFERENCE] its four attempts were intended for HTTP/network errors, not byte-silence timeouts. The cd8ce85 commit supplies no rationale beyond its subject and agent trailer.

## Acceptance

```sh
bun test packages/ai/test/google-gemini-cli-byte-watchdog.test.ts packages/ai/test/google-gemini-cli-first-event-timeout.test.ts
# Before: repeated pre-output timeout exceeds one request per endpoint; after: <=one timeout per endpoint then session changed-prompt recovery/fallback.
# Controls: bytes/comments keep slow streams alive; successful alternate endpoint recovers on a fresh connection; caller abort and emitted output are never replayed.
bun check
```

Ship in orb.8 with the parity release, retain source/installed SHA256 and portable before/after receipts. Preserve HTTP429/5xx network retry behavior except timeout-specific repetition.

## Resolution

Resolved by merged PR #23, commit 6ca1c55288fdb22253da14798177f70818452d6f; released/installed v18.18.5-orb.8. Before: portable watchdog controls8pass6fail; emitted-output stall controls0pass2fail. After: provider/utility282pass0fail with endpoint limits, changed-prompt classification, emitted-output, callerabort, raw-byte trickle and preserved HTTP/network retry controls. Session/settings308pass0fail; scoped TS lint/format clean; workspaceTS stage completed and Rust stage passed after installing missing Ninja. No applicable release-branch CI checks were reported.

Installed and downloaded binary SHA256 536f9d180a771a3638a8f282e501cb90cdc9e451c91031447c19efc662a42cf8; compiled identity orb.8 6ca1c55. New-process default-off Carbon/Hydrogen exact-reply controls passed. Strict codesign/checksum and installed manager identity verified; rollback binary ~/.local/share/omp/bin/omp.pre-orb8-backup plus manager.pre-orb8-backup.json. No existing omp process restarted. Native ticket closed DONE with exact resolving SHA and /Users/compoooter/tmp/workers/carbon-official-parity/RESULT.md plus INSTALL-RECEIPT.json. Full-parity HTTP429 remains a documented opt-in limitation, not a timeout recovery success claim.

## Log

- 2026-11-12T19:00:00Z filed CarbonOfficialParity-81556c038d06 01a1d10a-9862-762d-8565-81556c038d06 user-priority timeout escalation defect.
- 2026-11-12T19:19:00Z recovered pinned introduction; approved optional shouldRetryError predicate preserving other callers' default retry behavior. Expanded the same timeout fix to emitted thinking/text: no session-level unchanged-body retry, while already emitted deltas remain untouched.
