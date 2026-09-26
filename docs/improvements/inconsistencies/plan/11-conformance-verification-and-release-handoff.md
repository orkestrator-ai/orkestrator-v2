# 11 — Prove the combined behavior and prepare release handoff

Status: Planned.  
Depends on: [02](02-mandatory-persistence-and-dispatch-barriers.md) through
[10](10-shared-transcript-cursor-validation.md), including step 09's recorded
product resolution.  
Findings: All.

## Goal

Demonstrate that the fixes work together across restart, background activity,
capacity limits, and provider-specific adapters. Replace “these modules have
tests” with evidence for the shared contracts that originally drifted. Keep
this verification proportional: use deterministic integration tests for exact
races and a small number of real-stack scenarios for actual user behavior.

## Conformance suite ownership

- [Existing provider drift tests](../../../../apps/backend/src/core/agent-provider-drift.test.ts)
  and [boundary tests](../../../../apps/backend/src/core/agent-provider-boundaries.test.ts).
- [Backend HTTP adapter](../../../../apps/backend/src/core/http-bridge-provider.ts)
  and [teardown](../../../../apps/backend/src/core/commands-registry-teardown.ts).
- [Browser agent-testing harness](../../../../e2e/agent-testing/browser-gateway.spec.ts).
- [Testing guide](../../../development/testing-guide.md) and
  [agent-testing guide](../../../development/agent-testing.md).

Keep vendor fakes at the engine boundary and HTTP/storage/projection behavior
real. Reuse common scenario definitions only where they express a genuinely
shared contract. Provider capabilities should select applicable scenarios; do
not create a universal fake agent that falsely grants every vendor every feature.

## A. Complete the cross-provider contract matrix

| Contract | Providers/layers | Evidence required |
| --- | --- | --- |
| Create acknowledgement recoverable | Managed native bridges; backend mappings | Published-file restart test; no graceful flush |
| Prepared intent before side effect | Prompt/steer implementations with durable journals | Held writer, failure injection, crash boundary |
| Close fences late operations | Cursor regression; compare other bridges | Deferred attach/send and exact resource cleanup |
| Early cancellation | Pi regression; Cursor comparison | Claim/preflight gates, no next-turn leakage |
| Bounded recovery state | Cursor and relevant shared persistence paths | Aggregate transcript overflow and essential-state refusal |
| Bounded steer with safe retry | Cursor; any shared helper adopters | Saturation, exact replay, recovered-run fence |
| Draft attachment parity | Every native capability entry | Type matrix, hydration and autosave round trip |
| Conversation retention | All six platforms and relevant tmux UX | Chosen close policy, unsupported path, explicit delete separation |
| Cursor normalization | Equivalent numeric-cursor bridges | Shared grammar and observable message windows |
| Background rehydration | Backend projection and real browser | Switch away, completion/prompt, return and reload |

For a provider whose contract cannot be exercised without an external service,
record the local contract test separately from live verification. A fake-client
pass does not establish vendor persistence semantics, and an unavailable live
dependency must remain visible in the evidence.

## B. Test interactions between the fixes

- [ ] Hold a prepared-record write, cancel the prompt, then close its tab. Release
  the writer/attach and verify zero new sends, safe cleanup, and a final snapshot
  that cannot revive the closed session.
- [ ] Fill aggregate transcript capacity, create a new session, then dispatch a
  prompt. Verify essential identity and prepared intent both precede acceptance.
- [ ] Fail mandatory publication after a prior successful create. Confirm the
  backend parks/rejects only what the bridge can prove and the session remains
  recoverable after the disk path is repaired.
- [ ] Reach steer capacity, lose a response, restart/recover the run, and exercise
  the same parked request. There must be no duplicate provider delivery and no
  fabricated `absent` status.
- [ ] Shed transcript display data, reload the bridge, then make incremental
  reads with both stale-valid and malformed cursors. Verify exact base indexes,
  truncation metadata, and bounded snapshot recovery.
- [ ] Restore an attachment-only Cursor/Grok draft after a bridge/backend restart.
  Composer readiness changes must not erase the saved image during hydration.
- [ ] Close while a permission/question is pending. Any still-live provider
  request is denied according to its contract; dead-generation cards are
  withdrawn, and a reload cannot resurrect an actionable stale card.
- [ ] Repeat lifecycle requests after a lost response. Idempotency must survive
  the backend's own durable intents, not just duplicate requests in one process.

## C. Run the standard automated gates

First run each changed owner's focused tests and typecheck through the logged
runner. After that succeeds, use the repository workflows:

```sh
mise run test:changed
```

```sh
mise run test:logged -- --name inconsistency-final-check -- mise run check
```

```sh
mise run test
```

Run each command separately. `test:changed` is iteration feedback, not final
proof. The aggregate runner already handles bounded logs and scheduling. Do not
add `tee`, bypass the host queue, or replace it with a bare root-level `bun test`.

If package metadata changed, also complete both owning-directory installs,
frozen installs, and the version-drift test using the repository-pinned Bun as
specified in AGENTS.md. Run release-sensitive iOS validation with `mise run
test:all` on an appropriate Mac if the final change warrants it; report unsupported
host coverage explicitly.

On failure inspect the printed artifact, rerun the owner alone when required,
and follow the existing flake registry workflow. Never rename or skip a test to
obtain a passing aggregate. Avoid broad reruns after a passing result unless a
new change or unresolved concern justifies them.

## D. Isolated real-stack verification

Use a unique profile such as `inconsistency-remediation-<run-id>` and a seeded
fixture. The commands below show the workflow, not fixed ports or production
paths:

```sh
mise run dev:test --profile inconsistency-remediation-<run-id> --fixture
```

```sh
mise run dev:status --profile inconsistency-remediation-<run-id> --json
```

```sh
mise run dev:login --profile inconsistency-remediation-<run-id> --json
```

Discover the ready `browserUrl`, ownership, fixture, and logs from status. Open
the single-use login URL without exposing the gateway token. Use only the seeded
fixture project. Keep the launcher in its owned long-lived session and use the
repository lifecycle commands for stop/reset.

Run the standard browser smoke against that profile through `test:logged`, then
the following targeted scenarios. Synthetic fault injection must be confined to
test fixtures/processes; do not add an unauthenticated production debug endpoint.

| Scenario | Procedure | Required visible/snapshot result |
| --- | --- | --- |
| Durable empty session | Create tab and choose settings; restart owned bridge before first send | Same logical mapping and settings; no unintended turn |
| Cursor startup close | Begin cold startup, close immediately, leave environment | No late work; no resurrected tab/session; cleanup status truthful |
| Pi startup interrupt | Submit, interrupt before acceptance, switch away | Intended turn stops; status settles; next prompt works |
| Cursor/Grok image draft | Attach fixture image; switch away; return; reload twice | Image metadata remains through hydration and autosave |
| Large transcript recovery | Produce controlled bounded fixture history, trigger shedding, reload | Honest truncated display, preserved session identity and controls |
| Steer saturation/recovery | Use a synthetic active run and reach configured test limit | Actionable refusal; current work continues; no duplicate recovery send |
| Retention after close | Complete fixture conversation, close, list/resume | Behavior matches the recorded policy for that provider |
| Pending interaction while inactive | Trigger safe fixture approval/question, switch away, return/reload | Authoritative pending/denied/withdrawn state and usable controls |

For every background scenario, verify both return-to-tab and a subsequent full
page reload. These exercise different state sources. Include narrow/desktop
viewports and keyboard controls if notices, confirmation copy, or compose UI changed.

Browser is the default for ordinary user flows. Use Electron tests only for
native IPC/window behavior affected by the implementation. Use the opt-in Docker
fixture for container lifecycle/path parity where required and available; never
use or retag the production image for these tests.

## E. Observability, rollout, and rollback

- [ ] Inspect logs/notices for bounded error codes, counts, state generations,
  and actionable recovery guidance. Verify no serialized state, prompt text,
  credentials, attachment bytes, or raw vendor error dumps are introduced.
- [ ] Confirm a publication failure degrades the affected feature while the
  backend/bridge process stays alive and errors remain observed.
- [ ] Record format changes and compatible bridge/backend versions. Exercise
  old persisted snapshots, old route capability responses, and pending teardown
  intents; do not rely on synchronized upgrades without testing the assumption.
- [ ] Use additive fields or unchanged formats where possible. Any new closed
  state or steering uncertainty fence must have safe old-record defaults and
  an explicit downgrade policy.
- [ ] Keep rollback non-destructive: never delete provider conversations or
  journals to make an older binary load. If a downgrade cannot preserve a safety
  fence, retain the state and refuse affected operations until compatible code
  runs. Do not silently remove the fence.
- [ ] No new global feature flag is required for the correctness fixes. If a
  retention rollout needs staged enablement, tie it to explicit negotiated
  support and record the cleanup behavior for each version combination.

## F. Evidence record and documentation

For each implementation unit append a compact evidence record here or link the
PR's checked-in test report. Keep the original review unchanged as a snapshot.

| Field | Required content |
| --- | --- |
| Revision/PR | Exact tested revision and human-review link |
| Finding IDs | Which acceptance criteria the change closes |
| Automated results | Exact commands, pass/fail counts, artifacts for failures |
| Race/restart evidence | Controlled gate, observed side-effect counts, published-state result |
| Browser evidence | Unique profile/run, viewport where relevant, tested flows |
| Compatibility | Old snapshots, old bridge routes, downgrade result |
| Limitations | Any unsupported/untested provider or required QA still outstanding |
| Cleanup | Profile stopped/reset, no surviving owned fixture processes |

- [ ] Update [the plan index](00-index.md) and each step's status together.
- [ ] Update [the living architecture](../../../architecture/agent-engines.md)
  for settled lifecycle/retention contracts and meaningful route changes.
- [ ] Keep [the documentation catalog](../../../README.md) current.
- [ ] Link the source findings to resolution evidence through this index, without
  erasing their original revision/evidence.
- [ ] Stop and reset each isolated profile with `dev:stop` and `dev:reset`.
  If preserving a fixture intentionally, state exactly why and how it is owned.
- [ ] Before any push, verify branch and upstream do not target `main`. Prepare
  reviewable PRs when authorized; leave every merge to a human maintainer.

## Final acceptance

- [ ] All nine findings have an implemented/tested resolution or an explicit
  accepted product outcome with truthful UI and tests.
- [ ] Every new mandatory barrier and lifecycle race has deterministic evidence.
- [ ] Shared conformance cases catch the original drift without hiding legitimate
  provider differences.
- [ ] Format, lint, affected typechecks, and the full repository test suite pass.
- [ ] Required inactive/reload browser paths pass and optional-layer limits are recorded.
- [ ] No pending product decision, unsafe compatibility fallback, or missing
  required validation is labeled complete.
- [ ] Only intended changes and bounded, non-sensitive artifacts remain.

The implementation is ready for maintainer review when these conditions hold.
A passing old baseline, passing mocks alone, or documentation of a still-broken
behavior is not sufficient to mark remediation complete.
