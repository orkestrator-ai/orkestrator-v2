# Multi Review scale and cost

Checked against `main` at `2459b05c` (2026-10-15). The browser suites and the
real-stack inactive-environment cycle were run against `31d0fb06` on
2026-10-17; see [Qualification results](#qualification-results-2026-10-17).
The restart continuation and step reminders were added on `9da80451`
(2026-10-17); see
[Restart continuation and step reminders](#restart-continuation-and-step-reminders-2026-10-17).
The Claude bridge reports restart interruptions since 2026-10-18; see
[Claude restart interruption](#claude-restart-interruption-2026-10-18).

Multi Review's control plane covers reviewer admission, observation,
persistence, evidence verification and consolidation input. Its cost must stay
bounded, and independent of retained review history, as a panel grows towards
the 32-reviewer maximum. The mechanisms shipped in #833, and #852 made the keyed
supervisor the default driver. What remains is rollback gates that outlived
their one-release window, the Build Pipeline steps' share of the two recovery
gaps the real-stack cycle found, and scale evidence
that was never collected.

## Current state

- **One runner, two owners.** `ReviewFanoutRunner`
  (`apps/backend/src/core/review-fanout.ts`) drives standalone Multi Review
  (`multi-review-service.ts`) and Build Pipeline review stages
  (`build-pipeline-review-fanout.ts`). Each unsettled reviewer is one task in
  `runBoundedTasks` (`review-fanout-scheduler.ts`). The limits are
  `DEFAULT_REVIEW_ADMISSION_CONCURRENCY` 4,
  `DEFAULT_REVIEW_OBSERVATION_CONCURRENCY` 8 and
  `DEFAULT_REVIEW_PROVIDER_CONCURRENCY` 4, clamped to
  `MAX_REVIEW_FANOUT_CONCURRENCY` 16. Both owners accept
  `reviewFanoutConcurrency`.
- **Commits.** Safety transitions commit immediately. Observations go through
  `ReviewFanoutRunner.stageObservation` and flush once per pass. All runner
  writes are serialised. The scheduler's queue is projected onto pending
  reviewers as `admissionState` / `queuePosition` (`review-fanout-admission.ts`);
  those are observations too, and cost no write of their own.
- **Evidence.** `ReviewEvidencePermits` and `evidenceGenerationKey`
  (`review-evidence-permits.ts`) give two verifications per evidence
  generation: one before fan-out admission and one before consolidation
  (`MultiReviewService.assertReviewPackageIntegrity`). Permits live in memory
  only and expire after `DEFAULT_EVIDENCE_PERMIT_MAX_AGE_MS` (30 minutes).
- **Transcript reads.** `PassTranscriptReader` (`review-fanout-transcript.ts`)
  reads at most once per progress-probe interval
  (`MultiReviewProgressTracker.nextProbeAt`). The reviewer tab reads through
  `multi-review-reviewer-transcript.ts`: `MAX_REVIEWER_TRANSCRIPT_MESSAGES` is
  500, `MAX_REVIEWER_TRANSCRIPT_BYTES` is 2 MiB, the source token is scoped to
  the session, and unchanged polls answer `unchanged`. A provider without
  `transcriptSnapshot` gets a bounded compatibility read marked
  `fallback: true` and counted as `transcript.ui_fallback`.
- **Scheduling.** `KeyedWorkflowSupervisor` (`workflow-supervisor.ts`) is the
  default. `wakeWorkflows` in `index.ts` delivers provider-transition wakeups
  to `MultiReviewService.wakeEnvironment`. `WorkflowDueScheduler`
  (`multi-review-scheduler.ts`) runs only when
  `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` names `multi-review` or `all`.
  `adaptiveScheduling: false` turns off both and restores a 1 s `setInterval`
  plus `requestTick` scan.
- **Payload budgets.** `packages/protocol/src/structured-review/budgets.ts`
  (`STRUCTURED_REVIEW_MAX_*`) bounds each report. `CONSOLIDATION_MAX_EVIDENCE_BYTES`
  (640 KiB, `review-consolidation-evidence.ts`) bounds consolidation input, and
  overflow throws `ConsolidationBudgetError` before dispatch.
- **Measurement.** `multi-review-efficiency.bench.test.ts` with
  `multi-review-efficiency-fixtures.ts` covers 1, 2, 4, 8, 16 and 32 reviewers,
  an 8-reviewer panel over 50 retained workflows, a mixed-provider panel and a
  slow reviewer. Production passes no observer, so
  `recordEfficiency` events go to `NOOP_EFFICIENCY_OBSERVER`.
- **Unreachable bridges.** A reviewer whose bridge cannot be reached (a
  `ProviderUnavailableError` from its status read or unattended-interaction
  sweep) keeps its session, request and state. The runner asks the host to
  drop that cached provider (`ReviewFanoutHost.providerUnavailable`), so the
  next pass resolves the connection again, which restarts a local bridge that
  died. The idle-poll bound (`REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS`) still fails
  a reviewer whose bridge never answers. Multi Review evicts its provider
  (`MultiReviewService.evictUnreachableProvider`); Build Pipeline review stages
  get the bounded retry but do not evict yet.
- **Follow-up turns.** A reviewer, and each Multi Review step (preparation,
  consolidation, Fix), gets two bounded same-session follow-ups under a fresh
  request id. The first is the result reminder (`workflowResultReminderPrompt`):
  a tool-mode turn that went idle with no accepted result gets it once, after
  `MAX_IDLE_RESULT_POLLS`. The reviewer's is in
  `ReviewFanoutRunner.prepareReviewerResultReminder`, the step's in
  `MultiReviewService.prepareStepFollowUp`. The second is the restart
  continuation (`workflowRestartContinuationPrompt`). A turn the provider
  reports as `interruption: "restart"` is continued once instead of failed,
  unless a result was already accepted. The Codex bridge reports that from its
  `restartFailure` notice on `/session/:id/status`, and the Claude bridge from
  a durable turn-in-flight mark on `GET /session/:id`
  (`session-manager-turn-interruption.ts`). The spent
  flags `resultReminderSent` and `restartContinuationSent` are persisted on the
  reviewer and on `activeRequest`, and the second miss or second restart fails
  closed. Build Pipeline review stages get the reviewer half through the shared
  runner.
- **Live cycle.** `e2e/agent-testing/multi-review-live.spec.ts`
  (`ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW=1`) runs the inactive-environment
  cycle on the real stack: unmount, renderer reload, backend restart and a
  killed reviewer bridge. Each case is a real two-reviewer review launched
  through the launcher. How to run it is in
  [agent-testing.md](../../development/agent-testing.md#automated-checks).
- **Storage.** `multi-reviews` is a SQLite `record` store (`STORE_LAYOUTS` in
  `storage-stores.ts`), one row per workflow. `StorageReviews`
  (`storage-reviews.ts`) reads and writes one row at a time (`loadStoreRow`,
  `updateStoreRow`); only launch, listing and the environment sweep read every
  workflow. Writers serialize on the store's mutation lease, and each save
  re-checks the controller fence and revision inside its own transaction.
  `validateMultiReviewController`, the fence check, reads one row and takes no
  lease. The benchmark asserts no whole-store read and two lease acquisitions
  per running pass at any panel size or retained history. The looped-review
  store follows the same rules.

## Outstanding work

### Code

1. **Remove the Multi Review rollback gates.** They were kept "for one release"
   when they merged during 2.16.x and have shipped in every release since,
   up to 2.20.0.
   - `MultiReviewServiceOptions.evidencePermits`: remove both `=== false`
     branches (the per-reviewer verify in the reviewer prompt callback and the
     early return in `verifyReviewEvidence`) and the test that exercises them in
     `multi-review-service-efficiency.test.ts`.
   - `adaptiveScheduling` and the legacy `setInterval` / `requestTick` tick.
     `DEFAULT_POLL_MS` stays, because the keyed supervisor uses it. Update the
     `multi-review-tick` (B16) comment in `packages/protocol/src/recurring-work.ts`.
   - `WorkflowDueScheduler`, `multi-review-scheduler.ts` and
     `multi-review-scheduler.test.ts` go when
     [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md) removes
     `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` for `multi-review`. Move
     `stableJitterMs` first if the keyed path still uses it.
   - Keep `reviewFanoutConcurrency` as ordinary configuration, but drop the
     rollback wording from its doc comment.
2. **Retire the reviewer-transcript compatibility fallback** in
   `multi-review-reviewer-transcript.ts` once no reviewer platform reaches it.
   `HttpBridgeProvider` and `OpenCodeProvider` both implement
   `transcriptSnapshot` today. A bridge that predates `/transcript` is handled
   lower down, in `readHttpBridgeTranscriptSnapshot`
   (`http-bridge-progressive.ts`), and never sets `fallback: true` (see
   [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md)).
3. **Give Build Pipeline's own steps the restart continuation and result
   reminder.** Its review stages share the runner and already have both. Its
   consolidation (`build-pipeline-review-fanout.ts`, the `status === "error"`
   branch) and other stage turns (`build-pipeline-service-supervisor.ts`) still
   fail on a cut-short turn or a missing result. Reuse
   `workflowRestartContinuationPrompt` and `workflowResultReminderPrompt`, with
   the same once-only, persisted spent flags.
4. **Add seeded, CI-sized randomised interleaving tests** across concurrent
   reviewers. They should interleave commit resolution, provider completion,
   cancellation, fence loss and restart. They were planned but never written.
5. **Close the measurement gaps.**
   - Verification counts only the package's declared size. Referenced artifact
     bytes are not reported.
   - There is no opt-in large-evidence case (hundreds of MiB, real hashing).
     The benchmark fakes verification.
   - There is no production sink for `recordEfficiency`. Either feed it into
     the backend's content-free recurring metrics, or stop treating "rollout
     observation" as a gate (see Open questions).

### Qualification

- **Real-stack inactive-environment cycle** and **browser suites**: done on
  2026-10-17, see [Qualification results](#qualification-results-2026-10-17).
  Re-run `multi-review-live.spec.ts` after any change to the fan-out, the
  reviewer tab or bridge session recovery.
- **A killed Claude Code process, live.** Add a disruption to
  `multi-review-live.spec.ts` that signals only the Claude reviewer's CLI
  child (confirmed a descendant of this profile's bridge, as the bridge-kill
  case does) while the bridge stays up. The reviewer should complete after
  the restart continuation. Only the SDK contract and unit tests cover this
  today (see [Claude restart interruption](#claude-restart-interruption-2026-10-18)).
- **Scale.** Run a mixed real-provider panel at 8 to 32 reviewers. Record that
  the caps hold under real rate limits, plus tail latency and peak RSS. This
  needs several providers' credentials; batch it with the runs in
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

### Deferred until measured

- **Backend-owned, content-addressed evidence store with read-only mounts.**
  Design it first: garbage collection, reference counting across workflows,
  crash recovery, quotas, macOS and Windows behaviour, container and local
  parity.
- **Provider batch status observation.** No bridge exposes batch status.
  `activityBatch` and `HttpBridgeActivityBatchReader` report activity only, not
  the settlement, usage and request reconciliation the runner needs.
- **Hierarchical (map/reduce) consolidation**, only if real workflows exceed
  `CONSOLIDATION_MAX_EVIDENCE_BYTES`. Intermediate merges must keep every
  source ID, and final provenance validation must still reject missing or
  invented IDs.
- **A `queuedAt` reviewer field**, only if queue time becomes user-visible.
  `admissionState` and `queuePosition` shipped for the flow graph's queue
  position ([0029-multi-review-flow-graph.md](0029-multi-review-flow-graph.md)); the
  graph shows the position only, so nothing would read a queue timestamp yet.
- **Skip identical renderer refetches.** `store-resource-sync.ts` refetches the
  whole workflow on every `multi-review` announcement. `resource-sync.ts`
  already coalesces per key. A real skip needs a per-workflow revision in
  resource-change events; the current revision is a global counter.

## Qualification results (2026-10-17)

Run on `31d0fb06` plus this change, on a macOS arm64 host with about ten other
live test environments. Profiles: `mrq-a5927117` (`dev:test --fixture
--credential-source claude --credential-source codex --agent-platforms
codex,claude`) for the live runs, and the disposable profiles the isolated
runner creates. Reviewers were Claude Haiku 4.5 and Codex GPT-6-Luna (low);
Codex GPT-6-Luna (low) prepared and consolidated.

| Suite or scenario | Command | Result |
| --- | --- | --- |
| Multi Review component specs | `ORKESTRATOR_E2E_PORT=14731 bunx playwright test --config e2e/playwright.config.ts e2e/MultiReviewLaunchDialog.spec.ts e2e/MultiReviewOverview.spec.ts e2e/MultiReviewFlow.spec.ts e2e/ReviewLaunchDialog.spec.ts` | Pass |
| Full component browser suite | `mise run test:browser` (on port 14732) | 326 passed, 69 skipped, 1 failed. All 73 Multi Review cases passed. The failure was `CoordinatorPaneTree` "drops in the mobile switcher…", which failed 2 of 3 times on its own on unchanged `main`; the test clicked inside dnd-kit's 50 ms post-drop click suppression, fixed in the spec ([0035-mobile-layout-gaps.md](../cross-cutting/0035-mobile-layout-gaps.md#constraints-and-rationale)). |
| Agent-browser suite | `mise run test:agent:browser:isolated` | 25 passed, 18 skipped (opt-in live cases), 1 failed: known flake [0224](../../tests/flaky-tests/0224-host-picker-narrow-tools-popover.md), which passed 4 of 4 alone. The suite has no credential-free Multi Review case; the launcher and reviewer tab are covered by the live cycle below. |
| Coordinator Multi Review action (opt-in) | `ORKESTRATOR_AGENT_TEST_REVIEW=1 … --grep "coordinator Multi Review action"` | Failed on a stale assertion: the exact text "Cancelled" is gone since the flow graph. It now matches the status line "Multi Review cancelled", and passes. |
| Live cycle: unmount | `multi-review-live.spec.ts` "settles while unmounted…" | Pass (2 full runs; an earlier run passed every snapshot check and failed on a spec selector). Settled to `ready` while unmounted. No cancellation, one prompt per reviewer, same sessions, `unchanged` conditional reads, no fallback. The graph, inspector, Fix control and the reviewer's read-only tab are right on return and after reloads. |
| Live cycle: renderer reload | "survives a renderer reload while reviewers run" | Pass (2 runs; one earlier attempt failed in preparation before the reload; the step reminder now covers it, see [Restart continuation and step reminders](#restart-continuation-and-step-reminders-2026-10-17)). |
| Live cycle: backend restart | "converges after a backend restart while reviewers run" | Pass under the fail-closed contract (2 runs). The Claude reviewer completed after its result reminder. The Codex reviewer failed with the restart message, and the review consolidated from Claude's report. Two earlier runs failed the stricter spec that required both reviewers to complete. One had the same split; in the other, both reviewers were cut short and the whole review failed. Fixed for Codex since; see [Restart continuation and step reminders](#restart-continuation-and-step-reminders-2026-10-17). |
| Live cycle: killed reviewer bridge | "isolates an interrupted reviewer bridge to that reviewer" | Before the fix the Claude reviewer failed at once with "claude bridge is not reachable" (the outcome of one of the two pre-fix runs was not recorded). After the fix (3 runs) the bridge was restarted and the reviewer continued in its session, then failed closed after the reminder (fixed since, see [Claude restart interruption](#claude-restart-interruption-2026-10-18)). The Codex peer completed every time. |

After the Multi Review Fix (`a1e36236`) and the `origin/main` merge
(`182a8ee0`), the whole live file ran again on a fresh profile: 4 of 4 passed
in 7.0 minutes, with the same per-reviewer outcomes as above.

Fixed in this change:

- **An unreachable bridge failed its reviewer at once.** That contradicted the
  error-scope table below, and Build Pipeline stages already reconnect on the
  same fault. Now the runner keeps the reviewer's state, Multi Review drops
  the dead provider so the next pass restarts the bridge, and the idle-poll
  bound still ends a bridge that never returns
  (`review-fanout-unreachable.test.ts`, and "reconnects a reviewer whose
  bridge became unreachable" in `multi-review-service.test.ts`).
- **The coordinator Multi Review agent-browser case** asserted text the flow
  graph no longer renders.

Decisions taken during the run:

- The live cycle has its own opt-in rather than `ORKESTRATOR_AGENT_TEST_REVIEW`,
  because its restart case stops and relaunches the profile, which would break
  any other case sharing the run.
- A backend restart is `dev:stop` then a relaunch with the stored credential and
  platform selection, without `--fixture`, which would recreate the fixture
  repository under live worktrees. That matches quitting and reopening the app.
- Restart and bridge outcomes are accepted per reviewer as completed or failed
  with a stated reason, and recorded as annotations, because fail-closed is the
  documented contract. Everything else is held strictly.
- The spec restarts preparation once if it fails before any reviewer starts,
  and records it, because that flake (now covered by the step reminder) is outside what the cycle
  tests.

### Review recovery follow-up (2026-10-17)

Validated on `4443c027` plus the recovery fixes in this commit, on macOS
arm64. Multi Review and Build Pipeline now evict only the failed cached
instance. Instance-scoped call counts and reviewer/read leases defer disposal
until concurrent dispatches and transcript reads finish. Observation retries
accept transport faults; malformed interaction responses fail promptly.
Retryable provider recreation errors share the existing bounded observation
budget without changing the dispatched session or request identity. Failure
text names the platform provider, including OpenCode.

- Deterministic tests cover a pending OpenCode dispatch plus a concurrent UI
  reader during peer eviction, exactly-once disposal, pipeline reconnection,
  transient and permanent recreation failures, and completion during an outage
  with a report or with the one result reminder.
- Live bridge kill: `ORKESTRATOR_AGENT_TEST_PROFILE=qa-review-recovery-1017
  ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW=1 mise run test:logged -- --name
  multi-review-live-bridge -- mise run test:agent:browser --
  e2e/agent-testing/multi-review-live.spec.ts --grep 'isolates an interrupted
  reviewer bridge'` passed (1 test, 92.5 seconds). The Claude reviewer failed
  closed after its result reminder; the Codex peer completed and the review
  consolidated. The case verified preserved sessions and dispatch identity,
  inactive-environment settlement, and UI rehydration after reload. This is
  recovery/failure-isolation evidence, not completion of an interrupted turn.
- Profile `qa-review-recovery-1017` used Claude 2.1.296 and Codex 0.162.1,
  with the spec's Haiku 4.5 and GPT-6-Luna defaults. It was stopped and reset.
  Content-free outcomes are in
  `output/agent-testing/qa-review-recovery-1017/browser/results.json`.
- The isolated browser runner forces
  `ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW=0`; its regression test starts with
  an inherited value of `1` and verifies the Playwright child's value is `0`.
  The actual isolated suite with that variable exported as `1` also skipped
  all four live Multi Review cases: 25 passed, 18 skipped, one existing narrow
  host-picker failure (489.7 seconds, exit 1; flake entry 0224). Its profile
  `qa-browser-67110e54-b3a` was stopped and reset automatically. Evidence:
  `output/agent-testing/qa-browser-67110e54-b3a/browser/results.json` and
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.9PgCqj/isolated-live-opt-in.log.gz`.
- `mise run check`, the focused backend recovery owners, the desktop isolated
  runner owner, and the recurring-work comparison all passed. The latter
  compared all 14 baseline scenarios without changing a work counter.
  Docker, Electron-specific and iOS scenario suites were omitted because
  these fixes do not change those paths.
- Final full suite: `mise run test:logged -- --name final-full-review-recovery
  -- mise run test` exited 1 after 409.7 seconds. All recovery tests, all other
  workspace packages and root/bridge/protocol groups passed. Backend reported
  8,636 passed, 41 skipped and one failure: the unchanged tracked-edit
  cache-hit flake [0180](../../tests/flaky-tests/0180-worktree-tracked-edit-cache-hit.md).
  Its complete owning file passed immediately on rerun (four tests,
  0.5 seconds). The earlier aggregate's three known timeout owners also passed
  separately; the wrapper-identity assertion found there was corrected and
  passed. The final static check passed after the test correction.
  Aggregate evidence is in
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IJ4t3D/`;
  the wrapper log is
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NEipUr/final-full-review-recovery.log.gz`.

## Restart continuation and step reminders (2026-10-17)

Built on `9da80451` (#1056 already merged), on macOS arm64 with other live
test environments on the host.

Fixed:

- **A restart failed a Codex reviewer mid-review.** The bridge's restart
  notice reached the backend only as text, and `ReviewFanoutRunner` failed any
  reviewer whose status read was `error`. The bridge now reports
  `interruption: "restart"`, and the runner and step runner continue the turn
  once (see Current state, "Follow-up turns").
- **Preparation and consolidation had no result reminder.** The step runner
  threw the `missingWorkflowResultMessage` failure as soon as the idle bound
  ran out. It now sends the reviewers' one reminder first.
- **Rehydrated Codex transcripts showed Codex's injected instructions as a
  user turn.** Codex 0.162 writes the global instructions block under
  `# AGENTS.md instructions` with no path. The rollout filter
  (`isSyntheticPersistedUserText`, `bridges/codex-bridge/src/history/rollout.ts`)
  only knew `# AGENTS.md instructions for <path>`. The live restart case found
  this. The first live run after the fix had the Codex reviewer complete
  through its continuation, but its rehydrated transcript showed three user
  turns where two were allowed. No reviewer transcript was checked after a
  restart before, because the Codex reviewer always failed.

Tests:

- `review-fanout-restart-continuation.test.ts` covers continuing in the same
  session, the second restart failing closed, a report submitted before the
  restart, retiring the tool slot, and an ordinary failure still failing.
  Three of the five fail without the runner change.
- `multi-review-service.test.ts` covers the preparation reminder and its bound,
  a consolidation continued after a restart, a second restart failing the
  step, and one reminder before a pasted-report failure. All four fail without
  the service change.
- The bridge status, provider parsing, prompt and protocol tests cover the new
  fields. `rollout.test.ts` covers the new instructions heading, and that a
  user's own text starting with it is still shown.

Live, on profile `mrq-restart-dcac9155`
(`dev:test --fixture --credential-source claude --credential-source codex
--agent-platforms claude,codex`, Claude 2.1.296, Codex 0.162.1, Haiku 4.5 and
GPT-6-Luna at low effort), the restart case was "converges after a backend
restart while reviewers run". It now requires the Codex reviewer to complete.
After the rollout fix it passed (157.5 s): Claude "completed after the result
reminder", Codex "completed after the restart continuation". The whole file
then passed 4 of 4 in 654.7 s. The restart case had the same outcomes. After
the killed bridge, Claude failed closed after its reminder (fixed since, see
[Claude restart interruption](#claude-restart-interruption-2026-10-18)) and
Codex completed. The profile was stopped and reset. The spec's prompt-count
failure message now labels each user turn (prompt, restart, reminder, commit
nudge, or a `<tag>`) without printing its text.

Not qualified live: the step reminder. A model forgetting its result tool is
rare (1 of 15 preparations on 2026-10-17) and cannot be forced on a real
provider, so only the deterministic tests cover it. No live restart landed
while preparation or consolidation was mid-turn, so the step continuation is
covered by tests only.

## Claude restart interruption (2026-10-18)

Built on `a5d338c1` on macOS arm64, with other live test environments on the
host.

Fixed:

- **A restart that cut a Claude turn short read as a finished turn.** The
  Claude bridge keeps session state in memory, so a new bridge process
  restored the session idle. The runner then sent the result reminder ("your
  work is done"), which a model that had never seen the diff refused. The
  bridge now writes a content-free `turnInFlight` mark (instance id, pid,
  start time) into the session's preferences file at the edges where a turn
  starts, owes a background continuation, settles, is stopped or its tab
  closes (`session-manager-turn-interruption.ts`). A process that restores the
  session with a mark from a process that is gone reports `status: "error"`,
  `error` and `interruption: "restart"` on `GET /session/:id`. The runner and
  steps continue the turn once, unchanged since #1070.
- **A Claude Code process killed under a turn failed it.** With the bridge
  still up, a CLI killed by a signal (the OOM killer, `pkill`, a container
  under memory pressure) is reported the same way, from the SDK's own
  classification (`errorClass: "process_killed_by_signal"`). The mark stays
  until a turn settles, so a bridge restart before the continuation still
  reports it.
- **A step whose bridge was unreachable failed the review at once.** The
  reviewer half was fixed on 2026-10-17; the step runner
  (`MultiReviewService.advanceFixModel`, which runs preparation,
  consolidation and Fix) still threw `claude bridge is not reachable`. It now
  keeps the request, drops the cached connection so the next pass reconnects,
  and fails only after the idle-poll bound ("…provider stayed unreachable").
  The Claude restart test found this: a killed bridge is unreachable on the
  pass before its replacement can report the interruption, so the step never
  saw it. The Codex test could not hit it, because there only the app-server
  child restarts and the bridge's HTTP server stays up.

Decisions:

- *Where the mark lives.* The per-session preferences file already holds the
  durable prompt journal, is written under a per-file lock and atomically
  renamed, and is deleted with the session. A separate file per turn would
  add a second store to clean up. The prompt journal alone could not carry
  it: structured-output turns (`outputSchema`) skip `claimPromptDispatch`.
- *Edge-synced, fire-and-forget.* The mark follows the session's own state
  (`running`, an owed continuation, or an unresumed interruption), written
  once per change, from synchronous turn code, without adding an await to
  the turn path. A bridge killed in the few milliseconds before the write
  lands reports idle, as before. A mark that was never cleared costs one
  continuation that a workflow would accept the earlier result on anyway.
- *Whose turn it was.* Several environments' bridges can share one Claude
  home. A mark from a live process other than this one is left alone; a mark
  carrying this process's pid under another instance id is a dead
  predecessor (pids repeat across container restarts). A reused pid can only
  make a restart read as idle, never invent an interruption.
- *A user stop and a tab close are not restarts.* Both clear the mark; a
  durable delete removes the whole file.
- *Only a signal counts for a killed CLI.* A non-zero exit is as likely a
  launch or sign-in fault, where continuing fails the same way. The bridge's
  own stops never reach this branch: they abort the turn first, or end it
  through `Query.close()`, which fails with its own "closed" error. The
  notice names the signal but drops the SDK's stderr tail.
- *Same message shape as Codex.* "Claude restarted before this turn
  finished, so its work stopped partway. Send a message to continue." It is
  shown to a user who opens the session, and the second-restart failure
  carries it.

Tests:

- `session-manager-turn-interruption.test.ts` (12 tests): the mark is written
  while a turn runs and cleared on completion, a user stop, a tab close and
  an ordinary failure; a restored mark from a dead process (or a dead
  predecessor with this pid) reports the interruption, also after a second
  restart, and the next turn clears it; a live peer's or this process's own
  mark is left alone; a malformed mark is ignored without failing the file
  closed to plan mode; a CLI killed by `SIGKILL` or `SIGTERM` is an
  interruption, for structured turns too; only the SDK's signal class counts.
  The two killed-CLI cases fail without the settle change.
- `sdk-compatibility.test.ts` pins the SDK fields against a fake CLI that
  kills itself mid-turn (0.3.296): `errorClass: "process_killed_by_signal"`
  and the signal name, for both signals.
- `apps/backend/tests/multi-review-claude-bridge-restart.test.ts`: a real
  Claude bridge process with a fake CLI whose turns never finish is
  `SIGKILL`ed mid-turn and a new one started on the same Claude home, for a
  reviewer and for a step. Through `HttpBridgeProvider` the runner reads
  `interruption: "restart"`, continues once in the same session (the new
  bridge resumes the rollout), and fails closed on a second restart. Both
  cases fail without the bridge change; the step case also fails without the
  step unreachable fix.
- `multi-review-service.test.ts`: a step whose bridge became unreachable
  keeps its request and continues once the reconnected bridge reports the
  interruption; one whose bridge never comes back fails after the bound. Both
  fail without the fix.
- `http-bridge-provider.test.ts` and the route test cover the field on the
  Claude snapshot route.

Live, on disposable profile `claude-restart-c2ab` (`dev:test --fixture
--credential-source claude --credential-source codex --agent-platforms
claude,codex`, Claude 2.1.296 with Agent SDK 0.3.296, Codex 0.162.1, Haiku 4.5
and GPT-6-Luna at low effort, bridges rebuilt first):

- `multi-review-live.spec.ts`, whole file under the old "Claude may complete
  or fail closed" contract: 4 of 4 passed in 560.1 s. After the backend
  restart, both reviewers "completed after the restart continuation". After
  the killed Claude bridge, Claude "completed after the restart continuation"
  and Codex completed. Before this change Claude failed closed after its
  reminder in both cases (2 of 2 runs on 2026-10-17). In the unmounted case,
  preparation restarted once ("Repository HEAD changed after discovery"),
  which the spec allows and records, as before.
- The restart and killed-bridge cases now require the Claude reviewer to
  complete (`agent-testing.md` updated). Re-run with
  `-g "backend restart|interrupted reviewer bridge"`: 2 of 2 passed in
  287.7 s, with the same outcomes.
- The profile was stopped and reset.

Not qualified live: a Claude Code process killed by a signal while the bridge
stays up. The live spec kills the whole bridge, and signalling only its CLI
child needs a new disruption in the spec; the SDK contract test and the unit
tests cover it. A restart during preparation or consolidation was again not
landed live, so the step continuation and the step reconnect are covered by
the deterministic tests (`multi-review-claude-bridge-restart.test.ts` uses a
real bridge process and a fake CLI).

## Constraints and rationale

- **The ten invariants.** Every change must keep all of these.
  1. The backend owns workflow state. Closing a tab, switching environment or
     unmounting React never pauses or cancels a review.
  2. Provider events are wake hints. Status, transcript, interactions and
     results are recovered from snapshots.
  3. Per reviewer: persist `dispatching`, make the send the next
     reviewer-local fallible operation, then persist `sent`. Never retry an
     ambiguous send under a new request ID.
  4. Controller fencing is authoritative. A controller that lost its lease
     cannot commit reviewer or workflow state.
  5. Cancellation, provider disconnect, approval timeout, malformed structured
     output and generation death fail closed.
  6. A package snapshot or integrity failure is workflow-fatal. A reviewer's
     provider failure is isolated to that reviewer.
  7. Every queue, transcript response, report, consolidation payload, metric
     label and log has an explicit byte and count bound.
  8. Metrics and logs carry no prompt, transcript, report, command, file,
     artifact, credential, token or attachment content.
  9. Standalone Multi Review and Build Pipeline stages use the one runner and
     behave the same.
  10. Default two-reviewer quality must not regress to gain speed.
- **Load-bearing guarantees.** Validation runs once and reviewers share its
  sealed artifacts instead of rerunning suites. The package pins one evidence
  state for every reviewer. Provider instances are shared per environment and
  platform. Preparation and consolidation reuse one session where the model
  allows. The reviewer tab polls its transcript only while it is active.
  Optimisations work around these, never replace them.
- **Safety commits versus observational checkpoints.** A transition that
  changes what may safely happen after a crash commits immediately, fenced:
  controller acquisition, release and cancellation ownership; reviewer session
  identity; request IDs and dispatch journal states; accepted results and
  terminal errors; phase transitions and consolidation or fix dispatch;
  snapshot identity, stale evidence and integrity failures; and user commands
  whose acknowledgement promises durable state. Token deltas, progress
  digests, `stalledSince` and non-authorising status refreshes are staged and
  flushed once per pass, and before any safety commit, shutdown or lease
  handoff. A failed observational flush is logged, never turned into a retry.
  A lost fence still propagates.
- **Lease and state stay together.** Do not split the controller lease from
  workflow state unless both commit in one transaction. A per-row
  `updateStoreRow` keeps the atomic fence-and-state commit.
- **Fence reads take no lease.** A fence check is only true at the instant it
  reads, and a lease held for it would be released before the caller acts, so
  it never protected the provider I/O that follows. Invariant 4 rests on the
  commit: the only commit path (`saveNow` → `saveMultiReviewWorkflow`) re-checks
  the fence and the expected revision inside its transaction. A SQLite read
  sees only committed state, and a takeover needs an expired lease, which the
  check already rejects, so a read racing a takeover answers as a serialized
  one would. Writers must stay serialized: a save carries the stored lease
  forward, so an unserialized claim racing it could lose a renewal.
- **Evidence verification is a safety boundary, not a cache.** It must still
  catch a changed package or artifact, a worktree or snapshot mismatch,
  evidence regenerated under a new validation run, a restart that lost trust
  state, paths swapped through links or mounts, and consolidation against
  different evidence from the reviewers'. Never cache a verification on path,
  mtime or size, and never persist a "verified" flag: files can change while
  the backend is down. Permits are scoped to workflow, phase, generation and
  controller token. They are dropped on failure, release, retry, reviewer
  restart and step restart. A watcher may invalidate early, but a missing
  watcher event is never proof of immutability.
- **At-most-once dispatch under concurrency.** Concurrency is across reviewers
  only. Nothing fallible runs on a reviewer between committing `dispatching`
  and its single send. A timeout, disconnect or unknown response parks the
  same request ID for explicit reconciliation. Never hold the commit queue or
  a storage lock across provider I/O. Cancellation beats queued admission.
- **Error scopes.**

  | Event | Scope | Result |
  | --- | --- | --- |
  | Package or snapshot verification failure | Workflow or stage | Stop admission, abandon live work, fail the owner |
  | Retryable provider create or prepare error | Reviewer | Stay pending or retrying; peers continue |
  | Ambiguous prompt send | Reviewer | Park the same request ID; peers continue |
  | Transient status or transcript read error, including an unreachable bridge | Reviewer observation | Keep prior state; reconnect and retry when due; fail after the idle-poll bound |
  | Turn cut short by a provider restart (`interruption: "restart"`) | Reviewer or step | Accept a result already submitted; otherwise continue once in the same session; fail on a second restart. Codex and Claude report one |
  | Structured result still invalid after repair | Reviewer | Fail that reviewer; keep the other reports |
  | Controller fence lost | Whole runner | Reject commits, stop new I/O; the new owner reconciles |
  | User cancellation | Whole owner | Drop queued work; decline or abort live sessions safely |

- **Restart continuation and step reminders (2026-10-17).**
  - *Detection is a structured bridge field, not text.* The Codex bridge
    already keeps a durable `restartFailure` notice for a turn its app-server
    restart stopped. `/session/:id/status` now reports it as
    `interruption: "restart"`, but only while the session's error is still that
    restart's message, so a later unrelated failure cannot inherit it. Matching
    `CODEX_RESTARTED_MID_TURN_MESSAGE` in the backend would break on any
    wording change. Having the backend infer "I restarted, so every sent turn
    was interrupted" would also continue turns that failed for real reasons. A
    bridge that predates the field fails the turn as before; there is no text
    fallback.
  - *A continuation, not a fresh attempt.* The session keeps the partial work,
    so one turn in the same session under a new request id
    (`workflowRestartContinuationPrompt`) resumes it. Restarting the reviewer
    in a fresh session would redo all of it. This does not weaken invariant 3:
    the bridge has journaled the interrupted request as terminal, so nothing
    about it is ambiguous, and the continuation is a new request rather than a
    re-send of the old one.
  - *Once, persisted.* `restartContinuationSent` survives restarts, so a
    provider that keeps dying (a crash-looping app-server) fails closed on the
    second interruption, as invariant 5 requires. A user who restarts twice
    during one turn loses that reviewer, the same as before this change.
  - *A submitted result wins.* A result accepted before the restart is used,
    and the continuation is skipped. An interrupted structured-output turn
    records an `ok: false` provider failure, which counts as no result.
  - *Separate budgets.* The continuation and the result reminder are spent
    independently. A continued reviewer can still forget to submit, and the
    reminder's "your work is done" is false right after a restart.
  - *Steps.* Preparation, consolidation and Fix share one step runner, so all
    three get the reminder and the continuation. Restricting it to two of them
    would have needed an extra kind check and given no benefit. The step
    reminder names the step's own work ("Your discovery work is already
    done").
  - *The rollout-filter fix ships here.* It is a one-line Codex bridge change
    found by this work's live check. Leaving it out would leave the
    strengthened restart case failing on every run.
  - *Claude and Build Pipeline steps were follow-ups.* Claude needed bridge
    work to report an interruption; it shipped on 2026-10-18 (see
    [Claude restart interruption](#claude-restart-interruption-2026-10-18)).
    Build Pipeline's own steps have a separate runner, and #1056 had just
    changed those files (Code item 3).
- Budget values and why they were chosen (640 KiB consolidation, 1 MiB per
  report, caps of 4/8/4/16, the 3 s running cadence), with the benchmark
  reproduce command, are in
  [`review-preparation.md`](../../architecture/review-preparation.md#fan-out-budgets-and-benchmark).

## Open questions

- Should `WorkflowDueScheduler` survive as the keyed-scheduling rollback
  target, or go with the switch?
- Is "rollout observation" still a gate? The deleted baseline's "Rollout
  observations" section was never filled. If the soak since 2026-09-24 is enough, remove the
  gates without a production metrics sink.

## Needs verification

- Whether any supported reviewer platform still reaches the reviewer-transcript
  fallback in production. On 2026-10-17 every completed Claude and Codex
  reviewer read in the live cycle answered without `fallback: true`; Cursor,
  Grok, OpenCode and Pi reviewers were not run.

## Related

- [0025-multi-review-panel-value.md](0025-multi-review-panel-value.md): consolidation
  quality, prefix-cache savings, presets and lenses.
- [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md): owns
  `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and the shared scheduling switches.
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md): support
  window for the transcript fallbacks.
- [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md): CI gates.
- Flake [0171](../../tests/flaky-tests/0171-multi-review-admission-benchmark-load.md),
  resolved on 2026-10-15: the slow-reviewer benchmark now asserts dispatch
  ordering instead of a wall-clock bound.
- [`review-preparation.md`](../../architecture/review-preparation.md) covers
  preparation, sealing and the fan-out budgets. No living doc covers fan-out
  supervision or consolidation; the rationale above is its only home.

## Replaces

- `docs/improvements/multi-review/README.md` (findings 1–6, phases 0–2,
  verification plan, success criteria, pipeline overview and "what is already
  efficient")
- `docs/improvements/multi-review/plan/00-index.md`
- `docs/improvements/multi-review/plan/01-baseline-and-performance-contract.md`
- `docs/improvements/multi-review/plan/02-lazy-transcript-observation.md`
- `docs/improvements/multi-review/plan/03-persistence-and-event-coalescing.md`
- `docs/improvements/multi-review/plan/04-evidence-verification-generations.md`
- `docs/improvements/multi-review/plan/05-bounded-concurrent-fanout.md`
- `docs/improvements/multi-review/plan/06-adaptive-supervision-and-provider-batching.md`
- `docs/improvements/multi-review/plan/07-progressive-reviewer-transcript-reads.md`
- `docs/improvements/multi-review/plan/10-scale-validation-rollout-and-cleanup.md`
  (all but the quality and cache-hit items)
- `docs/improvements/multi-review/plan/baseline.md` (budgets, rationale and
  reproduce command moved to `review-preparation.md`; the 2026-09-23
  before/after tables and the empty rollout log were dropped)
