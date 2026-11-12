# TICKET-harness-antigravity-signature-component-isolation: Isolate signature replay and requestType429 effects

Schema-Version: 2
Kind: feature
Status: OPEN
Lane: harness
Repo: interpsys/oh-my-pi
Owner: CarbonOfficialParity-81556c038d06@chat
Issuer: Main-d63ad71f069c (session omp:01a1cec4-6aa4-7447-a546-d63ad71f069c; host compoooters-macbook-pro)
Created: 2026-11-12T21:22:57.514Z
Pinned: 6ca1c55288fdb22253da14798177f70818452d6f
Source: finding:/Users/compoooter/tmp/workers/carbon-official-parity/RESULT.md
Files: packages/ai/src/providers/google-gemini-cli.ts, packages/ai/src/providers/google-shared.ts, packages/ai/src/types.ts, packages/ai/src/stream.ts, packages/ai/test/, packages/coding-agent/src/config/, packages/coding-agent/src/session/, packages/coding-agent/src/build-info.ts, packages/coding-agent/test/, packages/{ai,coding-agent}/CHANGELOG.md, docs/, tickets/
Dedup-Key: antigravity-signature-requesttype-components-orb9
Acceptance-SHA256: 751000ae8558f3ce59eae94b223ddc2495d698eb4a5641fe37974000ad018c05
Disjoint-Paths: new provider component switches, related settings/options/callers/tests and release identity
Contract-Ref: /Users/compoooter/tmp/workers/carbon-official-parity/RESULT.md
Why-No-Repro: This adds independent experimental switches. The prior immutable full-bundle comparison already observed parity140/140HTTP429 versus baseline0/140HTTP429; component attribution is a hypothesis, not a reproduced root cause. The new experiment tests it without post-hoc changes to the old trial.

## Goal & Motivation

Parent authorization after orb.8: prior full parity was consistently rejected on real contexts, while an earlier independent reproduction found keep-signatures-only0/10empty versus7/10baseline. Preserve orb.8 full parity default-off; decompose its exact components, then compare fresh A/C trials and short D attribution trials. requestType causing429 is [INFERENCE] until independently tested. Historical requestType omission f1fb41a9687191114be4a407b16c9fdcfb761027 states an RFC2119/false429 rationale; this does not establish a separate quota bucket.

## Scope & Non-Goals

Add independently overridable Antigravity-Gemini-only controls: antigravityKeepSignatures, antigravityRequestTypeAgent, antigravityFunctionIds, antigravityModelFunctionResponses, antigravityOmitToolConfig, antigravityToolPacking, antigravityOmitUnsignedThoughts. Preserve the orb.8 umbrella setting with explicit per-component false overriding it. C enables only keep-signatures; D only requestType. No request retries, fallback, account routing, prompt edits, parser changes, or transplanting Carbon signatures as Hydrogen. Same-model Hydrogen continuity remains covered. No changes to old manifests, ledgers or old outcomes.

## Interface & Contract

Provider option names are optional booleans with the exact names above; absent inherits antigravityRequestParity, explicit false always wins. Settings expose inherit/on/off, initially inherit (umbrella off), with direct/side-call/global-default routes consistent. Other routes ignore the switches. The future keep-signatures default is a separately frozen shipping decision, not an implementation assumption.

## Acceptance

### Positive Control

```sh
bun test packages/ai/test/google-antigravity-request-parity.test.ts packages/coding-agent/test/settings-stream-fn.test.ts
# All official components together retain capture parity. C changes only signature preservation, D only requestType. Explicit false overrides umbrella on.
```

### Negative Control

```sh
bun test packages/ai/test/google-antigravity-request-parity.test.ts
# All components off is exact orb.7 baseline; other providers/model-switch signature isolation unchanged.
```

### Non-Regression Baseline

```sh
bun test packages/ai/test/google-gemini-cli*.test.ts packages/ai/test/google-shared*.test.ts
bun check
# Scoped lint/format/typechecks, applicable CI and installed positive/negative setting controls.
```

Freeze a NEW protocol/manifest before requests using the seven existing model/state cells and identical private inputs. A=baseline, C=keep-signatures-only, D=requestType-agent-only. Carbon five states20/arm A/C; Hydrogen two states10/arm A/C; D5per model/state=275 assigned requests. Same account13/daily endpoint, interleaved, no retries/fallback, full stream and every failure in denominator, <=400 NEW physical requests including controls/smokes. Preserve old280-trial result unchanged. Report all per-state/model/arm empty/400/429/ok Wilson95 intervals, paired effects, holdout, A/A noise, manifest reconciliation and qualified missing billing data.

Release/install orb.9 with keep-signatures default-on only if C reduces empties with preregistered confirmed benefit and noninferiority on400/429/other failures and usable output; otherwise keep it off and report. Record binary/release SHA256, installed content identity, rollback, controls, exact restart command without restarting existing processes. Close native ticket at exact resolving pushed SHA.

## Provenance

New feature; no introducing defect commit asserted. Bundle experiment and predecessor provenance are pinned in orb.8 RESULT.md and prior closed tickets. Component causality and separate quota-bucket explanation are unproven.

## Resolution

Not yet implemented or tested.

## Log

- Issuer Main-d63ad71f069c authorized new independent switches, NEW A/C/D preregistered trial, and conditional orb.9 release after immutable orb.8 A/B showed universal parity429.
