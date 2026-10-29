# Multi Review scale and cost

Checked against `main` at `2459b05c` (2026-10-15). The browser suites and the
real-stack inactive-environment cycle were run against `31d0fb06` on
2026-10-17; see [Qualification results](#qualification-results-2026-10-17).
The restart continuation and step reminders were added on `9da80451`
(2026-10-17); see
[Restart continuation and step reminders](#restart-continuation-and-step-reminders-2026-10-17).
The Claude bridge reports restart interruptions since 2026-10-18; see
[Claude restart interruption](#claude-restart-interruption-2026-10-18).
Every code item and the killed-Claude-CLI qualification were finished on
2026-10-25 on top of `ba7cc8d4`, with a first 8-reviewer scale run; see
[Gates, fallback, pipeline reminders and measurement](#gates-fallback-pipeline-reminders-and-measurement-2026-10-25).
Only the scale qualification is left.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Mixed real-provider scale run**: an 8 to 32 reviewer panel across more platforms than Claude and Codex, recording caps, tail latency and peak RSS. Status: open (blocked on Cursor, Grok, OpenCode and Pi credentials in a test profile, and on the harness only knowing Claude and Codex).
2. **Live step reminder and step continuation**: preparation, consolidation and Fix follow-ups are covered only by deterministic tests. Status: deferred (cannot be forced on a real provider).
3. **Content-addressed evidence store**: a backend-owned, read-only evidence store. Status: deferred (until measured).
4. **Provider batch status observation**: one bridge call for many reviewers' settlement and usage. Status: deferred (no bridge exposes it).
5. **Hierarchical consolidation**: map/reduce merges when evidence exceeds `CONSOLIDATION_MAX_EVIDENCE_BYTES`. Status: deferred (no overflow has been observed, and nothing counts one).
6. **`queuedAt` reviewer field**: a queue timestamp for the flow graph. Status: deferred (nothing would read it).
7. **Skip identical renderer refetches**: avoid refetching an unchanged workflow on every `multi-review` announcement. Status: deferred (premise partly out of date, see below).
8. **File hygiene**: stale wording about 0112, and what happens to this file after task 1. Status: open.

### 1. Mixed real-provider scale run

**Problem.** The fan-out caps, reviewer tail latency and backend memory have one real measurement: 8 reviewers, Claude and Codex only (2026-10-25). Panels can be up to 32 reviewers on any of the six platforms, so a user running a large mixed panel is on behaviour nobody has measured under real rate limits.

**Context.** The only item left in this file. The harness exists (`ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE=<n>`), and the run is batched with the "Several providers at once (mixed panels)" row of [0031](../cross-cutting/0031-live-provider-and-platform-qualification.md) alongside [0025](0025-multi-review-panel-value.md). The folder index rates the file Low because the remaining work is a measurement blocked on credentials.

**Investigation.**
- The scale case is `e2e/agent-testing/multi-review-live.spec.ts:921` onward. It is Claude and Codex only by type, not just by data: `pick` takes `"claude" | "codex"` (`:935`), reviewers alternate `claude`/`codex` (`:966`), and the per-platform sampling loop names only those two (`:987`). Only `CLAUDE_MODEL` and `CODEX_MODEL` overrides exist (`:73`-`:74`). Extending it is more than "adding their model picks", as the file says: the type, the alternation and the sampling loop all need to change.
- The protocol accepts any platform as a reviewer (`isAgentPlatform` in `packages/protocol/src/review-fanout.ts:334`), and `REVIEW_FANOUT_MAX_REVIEWERS` is still 32 (`review-fanout.ts:34`). The caps are unchanged (`apps/backend/src/core/review-fanout-scheduler.ts:18`-`:24`).
- **The harness cannot observe the per-provider cap.** `DEFAULT_REVIEW_PROVIDER_CONCURRENCY` bounds concurrent *operations* within one runner pass (`review-fanout-scheduler.ts:22`, tasks built at `review-fanout.ts:857`), not reviewers whose turn is running on the provider. The spec counts reviewers with `status === "running"` per platform (`multi-review-live.spec.ts:987`) and never asserts it. Only the admission figure is asserted (`:1022`). The 2026-10-25 "at most 4 per platform were running" follows from 8 reviewers alternating over two platforms (4 each), not from the cap. A 32-reviewer panel can have 16 Claude turns running at once without breaking any cap. The scheduler's real figures (`BoundedTaskStats.maxActiveByGroup`, `review-fanout-scheduler.ts:58`) only go to `this.record` (`review-fanout.ts:891`), which is `NOOP_EFFICIENCY_OBSERVER` in production (`multi-review-efficiency.ts:118`).
- RSS is sampled for the backend pid only (`multi-review-live.spec.ts:955`). Bridges and agent CLIs are separate processes, so peak RSS excludes the processes that grow with panel size.
- `dev:test` accepts `--credential-source` for all six platforms (`apps/desktop/scripts/dev/arguments.ts:28`, `:98`; `AGENT_PLATFORMS` in `packages/protocol/src/agent-platforms.ts:2`). The blocker is which credentials a given host holds, not the tooling. The pinned versions are Grok 1.0.67, Pi 1.4.0 and OpenCode 1.19.4 (`docker/Dockerfile:195`-`:197`). The earlier runs were on macOS; this Linux host was not checked for credentials (research only).

**Decisions.**

- **How should the scale case prove the per-provider cap?**
  - **Expose the pass's `BoundedTaskStats` to the test (recommended).** For example, a test-profile efficiency observer that records `maxActiveByGroup` content-free, read back through the profile.
    - Pros: measures exactly what the cap bounds; content-free; no production surface if it is only on in agent-test profiles.
    - Cons: new plumbing in the backend for a test; per-pass maxima still miss operations that overlap across passes.
  - **Keep snapshot sampling and drop the per-platform claim.** Record running counts as a load figure only.
    - Pros: no code change.
    - Cons: the item asks that "the caps hold under real rate limits", and this cannot show it for the provider cap.
  - **Count in-flight requests at each bridge.**
    - Pros: independent of backend internals.
    - Cons: touches five bridges, and counts other traffic too.
- **Which panel and composition count as a pass?**
  - **8, 16 and 32 reviewers, round-robin over every platform with credentials, at least four platforms (recommended).**
    - Pros: covers the range the item names; each platform reaches the provider cap at 32; shows how latency and RSS scale.
    - Cons: three long runs (the case allows 45 minutes each) and real cost.
  - **32 only.**
    - Pros: one run; the worst case.
    - Cons: no scaling curve, and a failure gives no smaller working point.
  - **Accept the existing 8-reviewer two-platform run and close the item.**
    - Pros: no further work.
    - Cons: no other platform has been a reviewer live (see Needs verification), and the cap evidence above is not real.
- **Should peak RSS include bridges and agent processes?**
  - **Sum the RSS of the profile backend's process tree (recommended).**
    - Pros: measures the cost that grows with panel size.
    - Cons: needs a process-tree walk on macOS and Linux; ownership must be confirmed before reading, following the production-host rules.
  - **Backend only, as today.**
    - Pros: simple and already recorded.
    - Cons: misses most of the memory a large panel uses.
- **Where and when to run it?**
  - **With the 0031 mixed-panel batch, after the harness changes above (recommended).**
    - Pros: one credential set-up serves 0025 and 0027; the harness is fixed first, so the run is worth its cost.
    - Cons: waits on 0031's scheduling.
  - **Now, on whichever host has the most credentials.**
    - Pros: earlier evidence.
    - Cons: without the cap fix it repeats the current gap; it may cover only three platforms.

### 2. Live step reminder and step continuation

**Problem.** The reminder and restart continuation for preparation, consolidation and Fix have never run on a real provider mid-step. A regression there would fail the whole review rather than one reviewer.

**Context.** Recorded as "Not qualified live" in the 2026-10-17 and 2026-10-18 results. A model forgetting its result tool cannot be forced (1 in 15 preparations on 2026-10-17), and no live restart happened to land mid-step.

**Investigation.** The step paths remain `MultiReviewService.prepareStepFollowUp` and `advanceFixModel` in `apps/backend/src/core/multi-review-service.ts`. `apps/backend/tests/multi-review-claude-bridge-restart.test.ts` drives a real Claude bridge process with a fake CLI through `HttpBridgeProvider` for a step. That is the closest thing to live, and it covers the continuation and the reconnect. The spec's restart case restarts the backend while *reviewers* run. Nothing in it targets preparation or consolidation.

**Decisions.**

- **Is deterministic coverage enough?**
  - **Yes, keep this out of the outstanding list (recommended).** The real-bridge restart test already crosses the process boundary, and the reminder cannot be triggered honestly.
    - Pros: no flaky live case built on timing; the contract is already pinned.
    - Cons: a provider-specific difference in mid-step restarts (for example Codex app-server) is untested live.
  - **Add a live disruption timed to the preparation or consolidation phase.** The spec already polls `phase`.
    - Pros: real evidence for the step continuation.
    - Cons: timing-dependent; another long live case; still cannot cover the reminder.

### 3. Content-addressed evidence store

**Problem.** Each review package and its validation artifacts are verified by hashing on disk twice per evidence generation. A shared, content-addressed, read-only store could cut that cost and share evidence across workflows.

**Context.** Deferred until measured. The file lists the design questions: garbage collection, reference counting, crash recovery, quotas, macOS and Windows, container and local parity.

**Investigation.** No such store exists in `apps/backend/src/core`. The 2026-10-25 benchmark (`multi-review-large-evidence.bench.test.ts`) measured 511 ms per generation for 512 MiB on pinned Bun 1.4.4, with RSS growth under 20 MiB. Container hashing was not measured.

**Decisions.**

- **What measurement would reopen it?**
  - **Container-side verification time at 256 MiB to 1 GiB, reopening if one generation exceeds a few seconds (recommended).**
    - Pros: covers the one path not measured; local numbers already look acceptable.
    - Cons: needs a Docker run of the benchmark, which does not exist yet.
  - **Retire the item.** Local cost is sub-second per generation.
    - Pros: removes a large speculative design.
    - Cons: container cost is unknown and may be much higher.

### 4. Provider batch status observation

**Problem.** Each running reviewer is observed with its own status and transcript reads, so observation calls scale with panel size.

**Context.** Deferred because no bridge serves a batch read of settlement, usage and request reconciliation.

**Investigation.** Still accurate. `activityBatch` (`apps/backend/src/core/agent-provider-contract.ts:707`), served by `HttpBridgeActivityBatchReader` (`http-bridge-provider.ts:498`) over `POST /sessions/activity`, returns activity state only. No bridge has a batch status route. The observation pool is bounded at 8 per pass, so the per-pass cost is capped already.

**Decisions.**

- **Keep it deferred, or retire it?**
  - **Keep deferred, tied to task 1's per-pass timing at 32 reviewers (recommended).**
    - Pros: decided by the run that measures it.
    - Cons: the item stays open.
  - **Retire now.**
    - Pros: a batch route on five bridges is a big contract change for an unmeasured gain.
    - Cons: loses the record if task 1 shows observation passes dominating.

### 5. Hierarchical consolidation

**Problem.** A panel whose reports exceed 640 KiB fails before consolidation dispatch with `ConsolidationBudgetError`, and the user loses the consolidation step.

**Context.** Deferred until real workflows exceed the budget. Merges must keep every source ID.

**Investigation.** `CONSOLIDATION_MAX_EVIDENCE_BYTES` is unchanged (`apps/backend/src/core/review-consolidation-evidence.ts:38`, error class at `:119`). Nothing counts how often the error fires: no metric or counter references it outside that module and the prompt builder (`multi-review-prompts.ts:109`). So the trigger the item waits for cannot be observed.

**Decisions.**

- **How will anyone know the budget is being hit?**
  - **Add a content-free counter to the existing recurring metrics when overflow throws (recommended).**
    - Pros: makes the deferral condition measurable; tiny and bounded.
    - Cons: new metric code (a new todo file, under the README rules).
  - **Rely on user reports.**
    - Pros: no code.
    - Cons: a failed consolidation may be read as a provider fault, so it is never reported as this.

### 6. `queuedAt` reviewer field

**Problem.** None today. The flow graph shows queue position only.

**Context.** Deferred until queue time becomes user-visible. `admissionState` and `queuePosition` shipped for [0029](0029-multi-review-flow-graph.md).

**Investigation.** Both fields exist (`packages/protocol/src/review-fanout.ts:112`, `:117`), and `queuedAt` does not.

**Decisions.**

- **Keep or retire?**
  - **Retire it (recommended).** Nothing reads it, and adding a field later is cheap.
    - Pros: removes a speculative item.
    - Cons: a future queue-time UI starts from scratch, which is small.
  - **Keep deferred.**
    - Pros: preserves the note.
    - Cons: noise in the file with no trigger anyone is watching.

### 7. Skip identical renderer refetches

**Problem.** Every `multi-review` resource announcement makes the renderer fetch the whole workflow, even when it has not changed since the last fetch.

**Context.** The file says a real skip needs a per-workflow revision in resource-change events, because the current revision is a global counter.

**Investigation.** The refetch is `onResourceChanged("multi-review", …)` calling `hydrateMultiReviewWorkflow` (`apps/web/src/lib/store-resource-sync.ts:631`, `apps/web/src/lib/multi-review-persistence.ts:20`). `ResourceChange.revision` is indeed the global sequence (`packages/protocol/src/resource-events.ts:186`). But the premise is partly out of date. Each stored workflow row already carries its own `revision`, incremented on every save (`apps/backend/src/core/storage-reviews.ts:601`), and the renderer receives it (`PersistedLoopedReviewWorkflow.revision`, `apps/web/src/types/index.ts:296`). Build Pipeline already uses that pattern: `get_build_pipeline` takes `knownRevision` and answers unchanged (`apps/backend/src/core/commands-registry-build.ts:137`, `apps/web/src/lib/backend/workflows.ts:1078`).

**Decisions.**

- **How to skip, if this is picked up?**
  - **A conditional `get_multi_review_workflow` with `knownRevision`, as Build Pipeline has (recommended).**
    - Pros: no event schema change; reuses a shipped pattern; saves the body transfer and the store replace.
    - Cons: the round trip still happens; the item stays deferred until refetch cost is measured.
  - **Add a per-resource revision to `ResourceChange`.**
    - Pros: skips the round trip entirely.
    - Cons: a protocol change across every resource kind, for one consumer.
  - **Leave it.**
    - Pros: no work; `resource-sync.ts` already coalesces per key.
    - Cons: a large workflow is re-sent on every staged observation flush.

### 8. File hygiene

**Problem.** Some text in this file is out of date, and the file's end state needs deciding.

**Context.** Under the README rules, items may be corrected in place, and a file is deleted once its last item is done.

**Investigation.** Assumption 13's cons ("two known recovery bugs ship until 0112 is done") and the Related entry for 0112 are stale. Both bugs were fixed in #1288 (`71abfcfb`), `review-fanout-interleaving.test.ts` has no `test.todo` left, and 0112 is marked Finished in the folder index. Its residual work moved to [0223](0223-provider-non-delivery-proof.md). `WorkflowDueScheduler` (`apps/backend/src/core/multi-review-scheduler.ts:52`, 229 lines) is still present, with `stableJitterMs` moved out to `multi-review-scheduling.ts:157` as stated, so its removal still belongs to 0048.

**Decisions.**

- **What to do with the file once task 1 is done?**
  - **Delete it and move the invariants, error scopes and safety-commit rationale into a living fan-out section of `architecture/review-preparation.md` (recommended).** The Related section says the rationale here has no other home.
    - Pros: follows the README; the durable design stops living in a todo file.
    - Cons: a sizeable doc move.
  - **Keep it as the design record.**
    - Pros: no move.
    - Cons: a finished todo file breaks the README rules, and the rationale is hard to find.
- **Should the stale 0112 wording be corrected now?**
  - **Yes, in the next change that touches this file (recommended).**
    - Pros: a reader no longer thinks two recovery bugs ship.
    - Cons: none of note.
  - **Leave it as history.**
    - Pros: preserves the record of the 2026-10-25 state.
    - Cons: it misleads anyone picking the file up.

Multi Review's control plane covers reviewer admission, observation,
persistence, evidence verification and consolidation input. Its cost must stay
bounded, and independent of retained review history, as a panel grows towards
the 32-reviewer maximum. The mechanisms shipped in #833, and #852 made the keyed
supervisor the default driver. What remains is scale evidence from a mixed
real-provider panel of 8 to 32 reviewers, which needs credentials for more
platforms than Claude and Codex.

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
  the session, and unchanged polls answer `unchanged`. Every read goes through
  the provider's `transcriptSnapshot`; a provider without it fails the read
  (the count-bounded compatibility read was retired on 2026-10-25).
- **Scheduling.** `KeyedWorkflowSupervisor` (`workflow-supervisor.ts`) is the
  default. `wakeWorkflows` in `index.ts` delivers provider-transition wakeups
  to `MultiReviewService.wakeEnvironment`. `WorkflowDueScheduler`
  (`multi-review-scheduler.ts`) runs only when
  `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` names `multi-review` or `all`, and
  goes with that switch
  ([0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md)).
  Both drivers share one relative due-time policy (`nextDelayMs`) and take
  the `schedulerClock` test seam. The legacy 1 s tick
  (`adaptiveScheduling: false`) and the `evidencePermits` gate are gone.
- **Payload budgets.** `packages/protocol/src/structured-review/budgets.ts`
  (`STRUCTURED_REVIEW_MAX_*`) bounds each report. `CONSOLIDATION_MAX_EVIDENCE_BYTES`
  (640 KiB, `review-consolidation-evidence.ts`) bounds consolidation input, and
  overflow throws `ConsolidationBudgetError` before dispatch.
- **Measurement.** `multi-review-efficiency.bench.test.ts` with
  `multi-review-efficiency-fixtures.ts` covers 1, 2, 4, 8, 16 and 32 reviewers,
  an 8-reviewer panel over 50 retained workflows, a mixed-provider panel and a
  slow reviewer. `evidence.verify` reports the package's bytes plus every
  referenced validation artifact's (`bytes`) and the artifact count (`count`).
  The opt-in `multi-review-large-evidence.bench.test.ts` times real hashing of
  hundreds of MiB. Production passes no observer, so `recordEfficiency` events
  go to `NOOP_EFFICIENCY_OBSERVER`; that is deliberate (see
  [Assumptions and decisions](#assumptions-and-decisions)).
- **Unreachable bridges.** A reviewer whose bridge cannot be reached (a
  `ProviderUnavailableError` from its status read or unattended-interaction
  sweep) keeps its session, request and state. The runner asks the host to
  drop that cached provider (`ReviewFanoutHost.providerUnavailable`), so the
  next pass resolves the connection again, which restarts a local bridge that
  died. The idle-poll bound (`REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS`) still fails
  a reviewer whose bridge never answers. Multi Review evicts its provider
  (`MultiReviewService.evictUnreachableProvider`); Build Pipeline review stages
  evict only the failed cached instance (review recovery follow-up below).
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
  runner. Build Pipeline's own stage turns and its consolidation get both too:
  the continuation since #1083 (`continueInterruptedStage`, the consolidation's
  `restartContinuationSent`) and the reminder since 2026-10-25
  (`remindMissingStageResult`, `prepareConsolidationResultReminder`), spent
  through `resultReminderSent` on `PipelineSession` and
  `ReviewConsolidationSession`.
- **Live cycle.** `e2e/agent-testing/multi-review-live.spec.ts`
  (`ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW=1`) runs the inactive-environment
  cycle on the real stack: unmount, renderer reload, backend restart, a
  killed reviewer bridge and a killed Claude Code process under a live bridge.
  `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE=<n>` adds an n-reviewer scale
  case. Each case is a real two-reviewer review launched
  through the launcher. How to run it is in
  [agent-testing.md](../../development/agent-testing.md#automated-checks).
- **Storage.** `multi-reviews` is a SQLite `record` store (`STORE_LAYOUTS` in
  `storage-stores.ts`), one row per workflow. `ReviewsRepository`
  (`storage-reviews.ts`) reads and writes one row at a time (`loadStoreRow`,
  `updateStoreRow`); only launch, listing and the environment sweep read every
  workflow. Writers serialize on the store's mutation lease, and each save
  re-checks the controller fence and revision inside its own transaction.
  `validateMultiReviewController`, the fence check, reads one row and takes no
  lease. The benchmark asserts no whole-store read and two lease acquisitions
  per running pass at any panel size or retained history.

## Outstanding work

### Code

All done on 2026-10-25; evidence in
[Gates, fallback, pipeline reminders and measurement](#gates-fallback-pipeline-reminders-and-measurement-2026-10-25).

1. ~~**Remove the Multi Review rollback gates.**~~ Done.
   - ~~`MultiReviewServiceOptions.evidencePermits`~~: both `=== false` branches
     and the "rollback gate restores per-reviewer verification" test removed.
   - ~~`adaptiveScheduling` and the legacy `setInterval` / `requestTick`
     tick~~: removed; `DEFAULT_POLL_MS` stays. The B16 comment in
     `packages/protocol/src/recurring-work.ts` is updated.
   - `WorkflowDueScheduler`, `multi-review-scheduler.ts` and its test stay,
     as the `multi-review` domain's rollback under
     `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK`. Their removal is owned by
     [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md)
     ("Code: after soak"). `stableJitterMs`, which the keyed path still
     uses, moved to `multi-review-scheduling.ts` on 2026-10-25, so that
     removal is now self-contained.
   - ~~Drop the rollback wording from `reviewFanoutConcurrency`~~: done.
2. ~~**Retire the reviewer-transcript compatibility fallback.**~~ Done. The
   branch, the `fallback` flag on snapshot reads, the `transcript.ui_fallback`
   operation and the `multi-review.reviewer-transcript-fallback` counter and
   register row are gone.
3. ~~**Give Build Pipeline's own steps the restart continuation and result
   reminder.**~~ Done. The continuation had already shipped in #1083
   (2026-10-18) for stage turns and consolidation; this file was not updated
   then. The reminder shipped on 2026-10-25.
4. ~~**Add seeded, CI-sized randomised interleaving tests.**~~ Done:
   `review-fanout-interleaving.test.ts`.
5. ~~**Close the measurement gaps.**~~ Done.
   - ~~Referenced artifact bytes are not reported~~: `evidence.verify` now
     carries them for both owners.
   - ~~No opt-in large-evidence case~~: `multi-review-large-evidence.bench.test.ts`.
   - ~~No production sink for `recordEfficiency`~~: decided against; rollout
     observation is no longer a gate (Open questions).

### Qualification

- **Real-stack inactive-environment cycle** and **browser suites**: done on
  2026-10-17, see [Qualification results](#qualification-results-2026-10-17).
  Re-run `multi-review-live.spec.ts` after any change to the fan-out, the
  reviewer tab or bridge session recovery. Re-run on 2026-10-25 after this
  change (see below).
- ~~**A killed Claude Code process, live.**~~ Done on 2026-10-25: "continues
  a reviewer whose Claude Code process was killed under a live bridge".
- **Scale.** Run a mixed real-provider panel at 8 to 32 reviewers. Record that
  the caps hold under real rate limits, plus tail latency and peak RSS. The
  harness exists (`ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE=<n>` in
  `multi-review-live.spec.ts`, which writes `scale.json`), and an
  8-reviewer Claude and Codex panel passed on 2026-10-25 (see below), but the
  panel it runs is Claude and Codex only. A mixed panel needs Cursor, Grok, OpenCode
  and Pi credentials that this host's test profiles do not carry; batch it
  with the runs in
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).
  Extending the case to those platforms means adding their model picks to
  its reviewer list.

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
| Agent-browser suite | `mise run test:agent:browser:isolated` | 25 passed, 18 skipped (opt-in live cases), 1 failed: known flake [0224](../../tests/flaky-tests/previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md), which passed 4 of 4 alone. The suite has no credential-free Multi Review case; the launcher and reviewer tab are covered by the live cycle below. |
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
  cache-hit flake [0180](../../tests/flaky-tests/environments-and-containers/0180-worktree-tracked-edit-cache-hit.md).
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

## Gates, fallback, pipeline reminders and measurement (2026-10-25)

Built on `ba7cc8d4` on macOS arm64 (Apple M5 Pro), with other live
environments on the host.

Code:

- **Rollback gates (item 1).** `evidencePermits` and `adaptiveScheduling` are
  gone from `MultiReviewServiceOptions`, with the legacy `setInterval` tick
  (`requestTick`, `tick`) and the test that exercised the permit gate. The
  keyed driver and `WorkflowDueScheduler` now share `nextDelayMs`, a relative
  delay each adds to its own clock, and the due scheduler and its lease
  renewal take the `schedulerClock` seam (`WorkflowDueSchedulerOptions.timers`,
  `inFlight`). The recurring-baseline harness used the legacy tick as a
  stand-in for the multi-review rollback; it now drives the real
  `WorkflowDueScheduler` on the manual clock. On the test fixture (30
  completed and 2 active workflows, 90 s) the rollback scans 7 times (224
  records) against the keyed driver's 4 (128), both read providers 104 times,
  and storage per attempt fell from a budget of 19 to 10 (475 reads over 59
  attempts). The run is deterministic (two runs equal).
- **Transcript fallback (item 2).** `readReviewerTranscript` throws when the
  provider has no `transcriptSnapshot` instead of reading `messages`. Tests
  whose fakes lacked the surface now give it one; five progress and usage
  tests in `multi-review-service.test.ts` opt out because they exercise the
  messages-based progress path, which is a separate surface.
- **Build Pipeline reminders (item 3).** At the structured-result deadline
  (`awaitStructuredResult`) a tool-mode stage turn gets one reminder in the
  same session under a new result key, through `sendStageFollowUp`, which the
  restart continuation now shares. The prompt is
  `workflowResultReminderPrompt`; the result kind comes from the slot's
  `binding`, because the turn's prompt context is cleared once it goes idle.
  The consolidation gets one when its idle-poll bound runs out
  (`prepareConsolidationResultReminder`), sharing
  `prepareConsolidationFollowUp` with its continuation. Neither applies to
  structured-output turns, to a slot that already holds a result
  (`received`) or one whose correction budget is spent (`needs-attention`).
- **Interleaving tests (item 4).** `review-fanout-interleaving.test.ts`
  with `review-fanout-interleaving-support.ts`: a seeded PRNG (mulberry32)
  holds every host commit and provider call (`save`, `provider()`,
  `createSession`, `send`, status reads, `structured`, `messages`,
  `abandonSession`, result-slot calls) pending and settles them in a
  seed-chosen order. Five suites of 24 seeds each, on panels of 2 to 8
  reviewers across Claude, Codex and OpenCode with seed-chosen concurrency
  limits, plan or build mode, and one of ten per-reviewer scripts (complete,
  fail, restart once, restart twice, invalid report once, no submit,
  ambiguous send, refused send, unreachable bridge, create failure): plain
  ordering, cancellation and reviewer stop at a random step, fence loss with
  an immediate takeover, a crash with a new runner over committed state, and
  random combinations. After every seed it checks at-most-once dispatch per
  request id (and at most one continuation, one reminder and three repairs
  per reviewer), no send from a fenced controller or after a committed
  cancellation, non-overlapping saves, settled state never going back, the
  admission, observation and per-provider caps, peer isolation, and that a
  restarted runner over a settled panel calls no provider. A failing seed
  prints its replay command; `ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS=<n>` or
  `=<s1>,<s2>` widens or replays a run. The file runs in about 3 s (127 tests,
  3 runs, no flakes); a local 4,000-seed sweep (20,000 scenarios) took about
  29 s. It found three runner bugs. One is fixed here: accepting a
  tool-transport report swallowed a `*FenceError` from `consumeResult` as a
  "Deferred result consumption", so a fenced pass resolved instead of
  rejecting (`review-fanout.ts` now rethrows; the case fails without it). The
  other two (a recovered `dispatching` request treated as sent without asking
  the provider, and a takeover mid-continuation counting the old restart
  twice) changed dispatch-recovery semantics, stayed as `test.todo` cases, and
  were fixed in todo 0112 (retired on 2026-10-29; see
  [review preparation, "Dispatch recovery"](../../architecture/review-preparation.md#dispatch-recovery)).
- **Measurement (item 5).** `verifyValidationArtifacts` returns the artifacts
  and bytes it hashed; `verifyEnvironmentReviewPackage` returns them as
  `artifacts` and `artifactBytes`; Multi Review's and the Build Pipeline
  fan-out's `evidence.verify` add them to `bytes` and report `count`. In a
  container the verifier now reads each artifact's size with `stat` before
  `sha256sum`, and enforces the same 32 MiB per-stream bound as on local
  disk.

Tests:

- `build-pipeline-result-reminder.test.ts` (5 tests): a tool-mode stage that
  never submits gets one reminder in the same session under a new key and
  either delivers or fails at the next deadline; a structured-output stage
  still fails without one; a tool-mode consolidation gets one and either
  delivers or fails after its idle bound. The four tool-mode cases fail with
  the reminder calls disabled.
- `review-validation-worker.test.ts`: local and container verification report
  artifact counts and bytes; a container artifact over 32 MiB is refused.
  `review-validation-service.test.ts` checks the real runner's report
  (`artifacts: 2, artifactBytes: 8`).
- `multi-review-reviewer-transcript.test.ts`: a provider without the surface
  fails the read without calling `messages`; joined history paging is still
  covered through a snapshot-only provider.
- `recurring-baseline.test.ts`: the multi-review rollback scans every 15 s,
  reads providers as often as the keyed driver, and stays within 10 storage
  reads per attempt.
- `build-pipeline-artifact-turns.test.ts`: both consolidation turns (the
  original and the reminder) get and settle their own artifact grant.

Large evidence, real hashing (`multi-review-large-evidence.bench.test.ts`,
local internal SSD):

| Bun | Evidence | Artifacts | Verify per pass | Per generation (2 passes) | Peak RSS growth |
| --- | --- | --- | --- | --- | --- |
| 1.4.4 (pinned) | 256 MiB | 8 | 149, 135 ms | 284 ms | 15 MiB |
| 1.4.4 (pinned) | 512 MiB | 16 | 253, 259 ms | 511 ms | 19 MiB |
| 1.4.2 | 512 MiB | 16 | 357, 514 ms | 871 ms | 28 MiB |
| 1.4.2 | 1 GiB | 32 | 1,158, 858 ms | 2,016 ms | 24 MiB |

A changed byte in the last artifact failed verification every run.
Container verification (hashing inside the container) was not measured.

Live, on disposable profile `qa-cli-kill-0027` (`dev:test --fixture
--credential-source claude --credential-source codex --agent-platforms
claude,codex`; pinned Claude Code 2.1.309, Agent SDK 0.3.309, Codex 0.164.0;
Haiku 4.5 and GPT-6-Luna at low effort):

- "continues a reviewer whose Claude Code process was killed under a live
  bridge" passed (137.5 s). The spec confirmed the bridge was a child of the
  profile's backend and that exactly one `claude --output-format stream-json`
  process was the bridge's child, then sent it `SIGKILL`. The bridge kept its
  pid; the Claude reviewer "completed after the restart continuation" and
  the Codex peer completed. The first attempt failed before signalling:
  the matcher excluded any command containing `mcp`, and the CLI's own
  arguments name its MCP config. It now matches the executable.
- The whole file then ran (635.8 s): the unmount and reload cases passed,
  and the backend-restart case failed on its prompt count. The Codex reviewer
  had completed after its restart continuation, but its rehydrated
  transcript held three user turns (`<environment_context>`, prompt,
  restart). Codex 0.164.0 persists its injected `<environment_context>`
  block as a user message, which the bridge's rollout filter
  (`isSyntheticPersistedUserText`, `bridges/codex-bridge/src/history/rollout.ts`)
  did not know; this is the same class as the 2026-10-17 `# AGENTS.md
  instructions` fix. The filter now drops a message that is exactly that
  block (`rollout.test.ts` covers it, and that a user's own text mentioning
  it is kept). Serial mode skipped the last two cases.
- After rebuilding the Codex bridge and restarting the profile,
  `-g "backend restart|interrupted reviewer bridge|Claude Code process was
  killed"` passed 3 of 3 (518.1 s). Restart: both reviewers "completed after
  the restart continuation" (189.7 s). Killed bridge: Claude "completed after
  the restart continuation", Codex completed (159.2 s). Killed CLI: the same
  (164.7 s).
- Scale harness, `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_SCALE=8` (four Claude
  Haiku 4.5 and four Codex GPT-6-Luna reviewers, Codex preparing and
  consolidating): passed in 261.3 s. All 8 completed and the review reached
  `ready` in 252 s. Reviewer latency p50 78.9 s, p95 and max 110.6 s. At most
  4 reviewers were setting up at once (the admission cap), and at most 4 per
  platform were running. Backend RSS went from 621 to 626 MiB. This is
  two-provider evidence at the bottom of the 8 to 32 range, not the mixed
  panel the scale item asks for.
- The profile was stopped and reset. Content-free outcomes are in
  `output/agent-testing/qa-cli-kill-0027/browser/results.json`.

Validation: `mise run format:check`, `mise run lint` and `mise run typecheck`
passed. The focused backend owners (46 Build Pipeline, Multi Review and
fan-out files, the recurring baseline, verification and transcript tests)
passed. `mise run test` exited 1 after 1,734.4 s on four five-second timeouts
in untouched tests under host load average 47 to 98, recorded as flake
[0820](../../tests/flaky-tests/aggregate-validation-runs/0820-multi-review-scale-cost-validation.md);
each owner passed alone, two of them only with a 30 s deadline under that
load. Browser, Docker, Electron and iOS suites were not run: no renderer,
container or desktop code changed, and the live real-stack Multi Review file
covers the reviewer tab.

## Assumptions and decisions

Taken on 2026-10-25 without stopping to ask, as the delegation required.

1. **`WorkflowDueScheduler`: keep it until the switch goes, or remove it now.**
   Chosen: keep it, and let 0048 remove it with
   `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=multi-review`. Why: the item itself
   tied its removal to 0048, whose "Code: after soak" has not started (the busy
   profile, live GitHub and providers soak have not run). Removing it now
   would leave the documented `multi-review` rollback value doing nothing.
   Pros: the rollback stays real, and is now measured on the manual clock
   instead of through a stand-in. Cons: about 230 lines live on for one more
   cycle, and 0048 must remember to move `stableJitterMs` first (its item now
   says so).
2. **The harness's multi-review rollback mode: drive the real due scheduler,
   drop the mode, or keep a stand-in.** Chosen: drive the real one, adding a
   `timers` seam and an `inFlight` count to `WorkflowDueScheduler` and a
   relative `nextDelayMs`. Why: the stand-in was the code being deleted, and
   dropping the mode would lose the only comparison of the two drivers. Pros:
   the comparison is now of what actually ships; one due-time policy feeds
   both drivers. Cons: the rollback numbers changed meaning (fewer scans,
   equal provider reads), so older `--compare` artifacts show differences for
   `multi-review` that are not regressions; the harness reaches the private
   scheduler through a cast, as it reached `requestTick` before.
3. **A provider without `transcriptSnapshot`: throw, return an empty
   snapshot, or keep a quiet fallback.** Chosen: throw a descriptive error.
   Why: no production provider lacks the surface, so the case only means a
   wiring bug; an empty snapshot would show a blank tab that looks healthy.
   Pros: an unbounded or legacy read cannot come back unnoticed. Cons: a test
   fake or a future provider must implement the surface to show a reviewer
   tab; the five tests that cover the messages-based progress path had to
   opt out explicitly.
4. **Where the stage reminder learns its result kind.** Options: the cleared
   `activePromptContext`, a new persisted field, or the result slot's own
   `binding`. Chosen: `binding`, checked against the phase's expected kind.
   Why: the slot already records the kind for tool-mode turns, which are the
   only ones the reminder serves, so nothing new needs persisting. Pros: no
   schema change beyond the spent flag. Cons: one extra slot read at the
   deadline, and no reminder when the slot store is missing the entry, which
   then fails as before.
5. **Reminder scope: tool mode only, or structured output too.** Chosen:
   tool mode only, as for reviewers and Multi Review's steps. Why: a
   structured-output turn has no tool to forget; a missing result there is a
   provider fault another turn does not fix. Pros: the same contract
   everywhere. Cons: none found.
6. **One shared follow-up helper or two copies.** Chosen: shared
   (`sendStageFollowUp`, `prepareConsolidationFollowUp`), with the spent flag
   as a parameter, like `MultiReviewService.prepareStepFollowUp`. Pros: the
   continuation and the reminder cannot drift. Cons: the restart path was
   touched; its restart prompt now says "review preparation" rather than
   the kind id `review-preparation`.
7. **Artifact bytes: a new efficiency field or the existing ones.** Chosen:
   `bytes` is now the package plus its artifacts, and `count` is the artifact
   count. Why: the event schema is a fixed, content-free set, and verification
   cost is what `bytes` was meant to measure. Pros: no schema change. Cons:
   `evidence.verify` bytes before and after this change are not comparable.
8. **Container artifact size: an extra `stat`, or no size in containers.**
   Chosen: `stat -c %s` before `sha256sum`, enforcing the local 32 MiB bound.
   Why: the producer caps each stream at 32 MiB already, so the check costs
   nothing legitimate, and a container artifact had no bound at all. Pros:
   parity with local disk and a real byte count. Cons: one more exec per
   artifact per verification (two verifications per generation); a container
   image without GNU or BusyBox `stat` would fail verification.
9. **Large-evidence case: through `verifyEnvironmentReviewPackage`, or the
   artifact verifier.** Chosen: `verifyValidationArtifacts` on a real local
   worktree. Why: the artifacts are what grows to hundreds of MiB; the
   package itself is a bounded JSON file whose hash is negligible, and the
   full path needs Git and the package generator. Pros: real files, real
   streamed hashing, bounded RSS checked, and runnable on any host. Cons: it
   does not time package parsing or container hashing.
10. **A production sink for `recordEfficiency`, or drop rollout observation
    as a gate.** Chosen: no sink. Why: the gates soaked from 2026-09-24
    through 2.30.0 with no recorded regression; the recurring metrics already
    count the supervisor's work content-free; and a second always-on metrics
    path would need its own bounds and retention. Pros: no new production
    surface. Cons: per-operation efficiency is measured only in tests and
    benchmarks; a production regression would show first in recurring
    metrics or user reports.
11. **Killed-CLI disruption: kill any Claude process, or one proven child.**
    Chosen: exactly one direct child of the owned bridge that is the
    stream-json `claude` executable, else fail before signalling. Why: the
    host runs other profiles and the installed app, whose Claude processes
    must never be touched. Pros: cannot signal anything else. Cons: a future
    SDK that launches the CLI differently fails the check and needs the
    matcher updated (the failure says so).
12. **Scale qualification: run what this host can, or wait.** Chosen: build
    the harness, run it at 8 reviewers on Claude and Codex, and leave the
    mixed-provider run open. Why: the item asks for a mixed real-provider
    panel, and only Claude and Codex credentials are on this host's test
    profiles. Pros: the caps, tail latency and RSS have a first real
    measurement, and the full run is one command when credentials exist.
    Cons: two providers at the smallest panel size is not the evidence the
    item asks for, and the 1 s sampling can catch a cap being exceeded but
    cannot prove it never was.
13. **Bugs the interleaving tests found: fix all here, file all, or split.**
    Chosen: fix the swallowed fence error, file the two dispatch-recovery
    bugs as 0112 and keep them as `test.todo`. Why: the fence fix is one line
    that restores a stated invariant; the other two need a provider
    dispatch-status answer and a change to which interruption a continuation
    honours, which is design work with its own risk. Pros: this change stays
    reviewable and CI stays green with the bugs pinned. Cons: two known
    recovery bugs ship until 0112 is done.
14. **Codex `<environment_context>` rows: fix in this change or file it.**
    Chosen: fix it here, in `isSyntheticPersistedUserText`. Why: the live
    restart case required by this file failed on it with Codex 0.164.0, the
    same way the `# AGENTS.md instructions` heading did on 2026-10-17, and the
    fix is one tightly matched condition (only a message that is exactly the
    block). Pros: rehydrated Codex transcripts stop showing an injected user
    turn. Cons: touches a bridge in a fan-out change.

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

- ~~Should `WorkflowDueScheduler` survive as the keyed-scheduling rollback
  target, or go with the switch?~~ It goes with the switch (decided
  2026-10-25; see [Assumptions and decisions](#assumptions-and-decisions)).
- ~~Is "rollout observation" still a gate?~~ No. The soak since 2026-09-24
  was enough, and the gates were removed without a production metrics sink.

## Needs verification

- ~~Whether any supported reviewer platform still reaches the
  reviewer-transcript fallback in production.~~ Settled from the code on
  2026-10-25: every reviewer provider is built by `createNativeAgentProvider`
  (`native-agent-provider.ts`) as either `HttpBridgeProvider` (Claude, Codex,
  Cursor, Grok and Pi bridges) or `OpenCodeProvider`, and both implement
  `transcriptSnapshot`. A bridge without `/transcript` is served inside
  `readHttpBridgeTranscriptSnapshot`, below this module. Cursor, Grok,
  OpenCode and Pi reviewers were still not run live.

## Related

- [0025-multi-review-panel-value.md](0025-multi-review-panel-value.md): consolidation
  quality, prefix-cache savings, presets and lenses.
- [0048-recurring-work-qualification.md](../transcripts-and-observation/0048-recurring-work-qualification.md): owns
  `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and the shared scheduling switches.
- [version-compatibility.md](../../architecture/version-compatibility.md#the-support-window): support
  window for the transcript fallbacks.
- [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md): CI gates.
- Flake [0171](../../tests/flaky-tests/coordinator-and-multi-review/0171-multi-review-admission-benchmark-load.md),
  resolved on 2026-10-15: the slow-reviewer benchmark now asserts dispatch
  ordering instead of a wall-clock bound.
- [`review-preparation.md`](../../architecture/review-preparation.md) covers
  preparation, sealing, the fan-out budgets and dispatch recovery (the two
  bugs the interleaving tests found). No living doc covers fan-out
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
