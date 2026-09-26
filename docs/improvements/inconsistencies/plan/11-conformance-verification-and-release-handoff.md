# 11 — Prove the combined behavior and prepare release handoff

Status: In progress (2026-09-26) — automated gates and the recorded live checks are done; the outstanding items in the evidence record remain. Not merged.  
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

- [x] Hold a prepared-record write, cancel the prompt, then close its tab. Release
  the writer/attach and verify zero new sends, safe cleanup, and a final snapshot
  that cannot revive the closed session.
- [x] Fill aggregate transcript capacity, create a new session, then dispatch a
  prompt. Verify essential identity and prepared intent both precede acceptance.
- [x] Fail mandatory publication after a prior successful create. Confirm the
  backend parks/rejects only what the bridge can prove and the session remains
  recoverable after the disk path is repaired.
- [x] Reach steer capacity, lose a response, restart/recover the run, and exercise
  the same parked request. There must be no duplicate provider delivery and no
  fabricated `absent` status.
- [x] Shed transcript display data, reload the bridge, then make incremental
  reads with both stale-valid and malformed cursors. Verify exact base indexes,
  truncation metadata, and bounded snapshot recovery.
- [ ] Restore an attachment-only Cursor/Grok draft after a bridge/backend restart.
  Composer readiness changes must not erase the saved image during hydration.
- [ ] Close while a permission/question is pending. Any still-live provider
  request is denied according to its contract; dead-generation cards are
  withdrawn, and a reload cannot resurrect an actionable stale card.
- [x] Repeat lifecycle requests after a lost response. Idempotency must survive
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

- [x] Inspect logs/notices for bounded error codes, counts, state generations,
  and actionable recovery guidance. Verify no serialized state, prompt text,
  credentials, attachment bytes, or raw vendor error dumps are introduced.
- [x] Confirm a publication failure degrades the affected feature while the
  backend/bridge process stays alive and errors remain observed.
- [x] Record format changes and compatible bridge/backend versions. Exercise
  old persisted snapshots, old route capability responses, and pending teardown
  intents; do not rely on synchronized upgrades without testing the assumption.
- [x] Use additive fields or unchanged formats where possible. Any new closed
  state or steering uncertainty fence must have safe old-record defaults and
  an explicit downgrade policy.
- [ ] Keep rollback non-destructive: never delete provider conversations or
  journals to make an older binary load. If a downgrade cannot preserve a safety
  fence, retain the state and refuse affected operations until compatible code
  runs. Do not silently remove the fence.
- [x] No new global feature flag is required for the correctness fixes. If a
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

- [x] Update [the plan index](00-index.md) and each step's status together.
- [x] Update [the living architecture](../../../architecture/agent-engines.md)
  for settled lifecycle/retention contracts and meaningful route changes.
- [x] Keep [the documentation catalog](../../../README.md) current.
- [x] Link the source findings to resolution evidence through this index, without
  erasing their original revision/evidence.
- [x] Stop and reset each isolated profile with `dev:stop` and `dev:reset`.
  If preserving a fixture intentionally, state exactly why and how it is owned.
- [ ] Before any push, verify branch and upstream do not target `main`. Prepare
  reviewable PRs when authorized; leave every merge to a human maintainer.

## Final acceptance

- [ ] All nine findings have an implemented/tested resolution or an explicit
  accepted product outcome with truthful UI and tests.
- [x] Every new mandatory barrier and lifecycle race has deterministic evidence.
- [x] Shared conformance cases catch the original drift without hiding legitimate
  provider differences.
- [x] Format, lint, affected typechecks, and the full repository test suite pass.
- [ ] Required inactive/reload browser paths pass and optional-layer limits are recorded.
- [ ] No pending product decision, unsafe compatibility fallback, or missing
  required validation is labeled complete.
- [x] Only intended changes and bounded, non-sensitive artifacts remain.

The implementation is ready for maintainer review when these conditions hold.
A passing old baseline, passing mocks alone, or documentation of a still-broken
behavior is not sufficient to mark remediation complete.

## Evidence record (2026-09-26)

Tested state: uncommitted working tree on branch
`implement-improvements-ecf7c41c13cd-r1` over base `06af4d86`. Not yet in a
PR; merge is left to a human maintainer. Work happened in two passes: the
first implementation, then a gap-closing pass after an item-by-item audit of
every step against the code. This record describes the result of both.

### Finding → change → regression evidence

| Finding | Change (owner) | Regression coverage |
| --- | --- | --- |
| INC-01 | Mandatory serialized `persistBarrier` (rejects on write/rename/budget/shutdown; one running + one waiting write). Prompt and steer publish the prepared record and the final agent identity before the SDK call and re-check close after it. A cancel parked during the barrier settles locally without calling the SDK. A `send` that rejects keeps ambiguous evidence and answers 502 `dispatch-outcome-unknown`, which the backend parks as `AmbiguousPromptDispatchError`. The prompt journal never evicts unresolved entries (Cursor `persistence.ts`, `http.ts`, `prompt.ts`; backend `http-bridge-provider.ts`) | `cursor-bridge/src/http-dispatch-durability.test.ts`, `http-prompt-outcome.test.ts`, `process-restart.test.ts` (real process, SIGKILL, fresh start); backend `http-bridge-provider-prompt-outcome.test.ts` |
| INC-02 | Permanent close: synchronous `closed` marker, one shared close operation, late attach disposed, late run cancelled and followed until the SDK reports terminal, rewind owned by close and blocking prompts, removal published before success, `closing` visible in reads, tombstones finished at bridge start and before any resume of the same agent (`session-close.ts`, `agent-session.ts`, `prompt.ts`, `public.ts`, `server.ts`) | `http-close-races.test.ts`, `http-close-tombstones.test.ts`, `http-prompt-outcome.test.ts` |
| INC-03 | Budgeted snapshot: oldest-touched transcripts shed; identities, journals and structured results kept; structured results bounded per session (4 MiB); typed `persistence-budget-exceeded` naming the largest sessions; a failing attempt holds at most budget + one record (`persistence-budget.ts`, `structured-results.ts`) | `persistence-budget.test.ts`, `persistence-bounds.test.ts` |
| INC-04 | Create, resume, identity-changing attach and composer config publish before acknowledging; each re-checks close after publishing; an unchanged warm attach writes nothing | `http-session-durability.test.ts`, `process-restart.test.ts` |
| INC-05 | Pi claim reserved at route entry (admission window), parked cancel answered 202 pending, SDK `abort()` on cancel during preflight, bounded startup deadline (`PI_BRIDGE_STARTUP_TIMEOUT_MS`), status/activity/messages report running while claimed, closing sessions refuse prompts and same-key creates, close stays registered until published | `pi-bridge/src/http-cancel-startup.test.ts`, `prompt-cancel-preflight.test.ts`, `session-close.test.ts`; backend `native-agent-service-abort-ladder.test.ts` |
| INC-06 | Structural validation + `nativeAgentCapabilities(platform).attachments`; undecided drafts kept and reconciled once after hydration (`native-draft-attachments.ts`, `useNativeComposeDraftPersistence.ts`, unassigned composer) | `apps/web/src/lib/native-draft-attachments.test.tsx` (renders the real unassigned composer); `e2e/agent-testing/native-draft-attachments.spec.ts` |
| INC-07 | Bounded steer journal (256 records / 512 KiB, persisted-form byte accounting), protected active-run records, time-bounded run fence, 429 refusals (`steer-capacity-exceeded`, `steer-not-recorded`), a missing record on a fenced run answered `unknown`, saturation in `runtime-health` and a transition notice, projected by the backend and shown in the runtime panel | `cursor-bridge/src/steer-journal.test.ts`, `conformance-interactions.test.ts`; protocol `native-agent-steer-rejection.test.ts`; backend `http-bridge-provider-steer-rejection.test.ts`, `native-agent-service-steer-rejection.test.ts`, `http-bridge-runtime-health.test.ts`; web `AgentNativeTab.steer-rejection.test.tsx`, `AgentInfoButton.steer-rejection.test.tsx` |
| INC-08 | Non-destructive `POST /session/:id/close` on every bridge. Close stays registered until complete, denies all parked interaction kinds, and answers 503 pending when a stop or publication is unproven. OpenCode closes through the provider (ownership settled, permissions restored, pending requests rejected, no `session.delete`). Teardown is serialized per provider session, 2xx must affirm `closed: true`, pending intents retry with backoff, and an old Claude bridge never falls back to DELETE and shows a restart notice (see the step 09 record) | Claude, Codex, Pi, ACP close tests; backend `commands-registry-teardown.test.ts`, `http-bridge-provider-close.test.ts`, `opencode-provider-close.test.ts`, `native-agent-service-close.test.ts`; web `paneLayoutStore.teardown-notice.test.ts` |
| INC-09 | `parseTranscriptFromIndex` shared by Pi, Cursor and ACP | protocol table tests; the shared conformance suite below |
| Cross-provider drift | Shared bridge HTTP-contract conformance suite: scenario definitions in `tests/conformance/bridge-contract/`, a capability table per bridge where every skip carries a reason, and one real-router runner per bridge (`bridges/*/src/conformance-bridge-contract.test.ts`), guarded by `tests/unit/bridge-contract-conformance.test.ts` | see the table below |

### Shared conformance suite

| Scenario | Cursor | Pi | Claude | Codex | ACP |
| --- | --- | --- | --- | --- | --- |
| Unknown session answered in band (`/activity`, `/close`) | run | run | run | run | run |
| Close retains, then answers missing | run | run | run | run | run |
| Pending close fences new prompts | run | run | run | run | run |
| Idle cancel/abort in band | run | run | skip: no `/cancel`; idle `/abort` answers `not_running` | skip: no `/cancel`; `/abort` answers 202 | skip: cancel/abort always 202 |
| Abort on idle acknowledged | run | run | run | run | run |
| Transcript cursor grammar parity | run | run | skip: no `fromIndex` | skip: no `fromIndex` | run |
| Create acknowledgement recoverable without a drain | run | run | skip: id derived from the client key, nothing saved at create | skip: id derived from cwd + key | run (hard kill + restart) |
| Dispatch probe answers `unknown` | run | run | run | run | run |
| Steer dispatch probe answers `unknown` | run | run | run | run | skip: no steer route |
| Bounded recovery summary | run | skip: no limits reported | skip | skip | skip |

The differing cancel/abort answers are recorded rather than changed; aligning
them is a product decision.

### Automated gates

| Command | Result |
| --- | --- |
| `mise run test:logged -- --name final-check -- mise run check` | PASS (format, lint with warnings only, all typechecks) |
| `mise run test` (final pass) | PASS: workspace 319.2 s, root 114.2 s, bridges 134.4 s, codex protocol lockfile. Two earlier full runs each hit one unrelated load flake (0165, 0166); both pass alone three times |
| Each changed owner's focused suites through `test:logged` | PASS |

No package export entries or dependency versions changed, so no lockfile
regeneration was needed.

### Real-stack evidence

Profile `inconsistency-remediation-qa` (`mise run dev:test --fixture
--agent-platforms cursor,grok,pi,claude,codex,opencode`), browser client. The
bridge bundles (`bridges/*/dist`, git-ignored) were rebuilt first: the dev
profile runs those bundles, not the sources.

| Scenario | Result |
| --- | --- |
| Full browser agent suite (`playwright.browser.config.ts`) | 10 passed, 6 skipped (Docker and live-agent opt-ins; assigned-Grok draft cases, see below) |
| Durable empty session: Cursor tab, plan mode chosen before any prompt, environment bridges stopped and started, page reloaded | Same provider session id, mode still plan, zero messages |
| Cursor/Grok image draft: assigned Cursor tab; pre-session picker with Cursor and with Grok selected; attachment-only; annotation kept; saved revision strictly increases after hydration; two hard reloads; environment switch; 390 px viewport with keyboard removal | PASS. Assigned Grok cases are skipped because the Grok CLI never connected in this profile; the spec verifies the stored draft and never reports PASS for an unobserved UI |
| Retention after close, Claude and Codex (final code): live turn, close through the UI, intent cleared, conversation still resumable | PASS for both (previously Claude's close deleted the conversation) |
| Close during startup, Claude and Codex | Teardown intent cleared |
| Older Claude bridge without the close route (first pass, stale bundle) | Intent kept pending with the restart message; no DELETE fallback |

### Compatibility and downgrade

- The Cursor state file stays `version: 1`, and the new fields are additive:
  `closing` tombstones, `steerFence` with `overflowBefore` and a legacy
  boolean. An older Cursor bridge ignores tombstones (the closed session is
  simply absent) and ignores the steer fence. It cannot deliver an evicted
  steer twice, because it never re-adopts a restored session's run and a
  parked steer blocks the eviction that would forget it. The residual case, a
  legacy oversized journal dropped on restore, is described in step 08
  "Compatibility and downgrade".
- New native teardown intents carry a `retain-history-close:` session id, so
  an older backend cannot replay them as a destructive DELETE (step 09).
  After a downgrade, new closes on an old backend with old bridges return to
  the old behaviour.

### Outstanding (not claimed as done)

- The maintainer's confirmation of the step 09 retention decision.
- Live checks that need credentials this profile does not have:
  - Cursor close during startup
  - Pi startup interrupt
  - Pi, Grok, OpenCode and Cursor retention after close
  - the assigned-Grok draft UI
- Browser checks not yet run:
  - large-transcript recovery
  - the steer saturation notice and refusal
  - a pending interaction while inactive
  - the restart-notice toast
- Docker, Electron and iOS suites: not run. No native IPC, window or container
  lifecycle code changed.
- Flakes recorded during this work:
  - 0165 and 0166: aggregate-load timeouts in code this branch does not change
  - 0167: dev-server module fetch; the draft spec retries it once and records
    the retry
- The profile was stopped and reset; no owned processes remain.
