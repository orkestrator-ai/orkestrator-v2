# Multi Review scale and cost

Checked against `main` at `2459b05c` (2026-10-15).

Multi Review's control plane covers reviewer admission, observation,
persistence, evidence verification and consolidation input. Its cost must stay
bounded, and independent of retained review history, as a panel grows towards
the 32-reviewer maximum. The mechanisms shipped in #833, and #852 made the keyed
supervisor the default driver. What remains is rollback gates that outlived
their one-release window, a timing-sensitive benchmark, and scale evidence that
was never collected.

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
  writes are serialised.
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
     [recurring-work-qualification.md](recurring-work-qualification.md) removes
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
   [mixed-version-compatibility.md](mixed-version-compatibility.md)).
3. **Add seeded, CI-sized randomised interleaving tests** across concurrent
   reviewers. They should interleave commit resolution, provider completion,
   cancellation, fence loss and restart. They were planned but never written.
4. **Close the measurement gaps.**
   - Verification counts only the package's declared size. Referenced artifact
     bytes are not reported.
   - There is no opt-in large-evidence case (hundreds of MiB, real hashing).
     The benchmark fakes verification.
   - There is no production sink for `recordEfficiency`. Either feed it into
     the backend's content-free recurring metrics, or stop treating "rollout
     observation" as a gate (see Open questions).

### Qualification

- **Real-stack inactive-environment cycle.** Start a panel and wait until a
  reviewer is running. Switch to another environment and leave the review
  unmounted. Let it finish, then return. Repeat with a backend restart, with a
  renderer reload, and with one bridge interrupted. Check phase, reviewer
  state, pending interactions, transcript tail, reports, consolidation and
  controls, and that no turn was duplicated or cancelled by the unmount.
- **Browser suites.** Run `mise run test:browser` (`e2e/MultiReviewLaunchDialog.spec.ts`,
  `e2e/MultiReviewOverview.spec.ts`) and `mise run test:agent:browser` for the
  reviewer tab and launcher.
- **Scale.** Run a mixed real-provider panel at 8 to 32 reviewers. Record that
  the caps hold under real rate limits, plus tail latency and peak RSS. This
  needs several providers' credentials; batch it with the runs in
  [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).

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
- **`admissionState` / `queuedAt` reviewer fields**, only if queue time becomes
  user-visible. At the default caps it is one setup wave. The flow graph now
  labels queued reviewers, and its queue-position follow-up in
  [multi-review-flow-graph.md](multi-review-flow-graph.md) would consume these
  fields.
- **Skip identical renderer refetches.** `store-resource-sync.ts` refetches the
  whole workflow on every `multi-review` announcement. `resource-sync.ts`
  already coalesces per key. A real skip needs a per-workflow revision in
  resource-change events; the current revision is a global counter.

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
  | Transient status or transcript read error | Reviewer observation | Keep prior state; retry when due |
  | Structured result still invalid after repair | Reviewer | Fail that reviewer; keep the other reports |
  | Controller fence lost | Whole runner | Reject commits, stop new I/O; the new owner reconciles |
  | User cancellation | Whole owner | Drop queued work; decline or abort live sessions safely |

- Budget values and why they were chosen (640 KiB consolidation, 1 MiB per
  report, caps of 4/8/4/16, the 3 s running cadence), with the benchmark
  reproduce command, are in
  [`review-preparation.md`](../architecture/review-preparation.md#fan-out-budgets-and-benchmark).

## Open questions

- Should `WorkflowDueScheduler` survive as the keyed-scheduling rollback
  target, or go with the switch?
- Is "rollout observation" still a gate? The deleted baseline's "Rollout
  observations" section was never filled. If the soak since 2026-09-24 is enough, remove the
  gates without a production metrics sink.

## Needs verification

- Whether any supported reviewer platform still reaches the reviewer-transcript
  fallback in production.
- Whether the browser and agent suites were ever run for #833's launcher and
  reviewer-tab changes. No run is recorded.

## Related

- [multi-review-panel-value.md](multi-review-panel-value.md): consolidation
  quality, prefix-cache savings, presets and lenses.
- [recurring-work-qualification.md](recurring-work-qualification.md): owns
  `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and the shared scheduling switches.
- [mixed-version-compatibility.md](mixed-version-compatibility.md): support
  window for the transcript fallbacks.
- [test-suite-and-ci-health.md](test-suite-and-ci-health.md): CI gates.
- Flake [0171](../tests/flaky-tests/0171-multi-review-admission-benchmark-load.md),
  resolved on 2026-10-15: the slow-reviewer benchmark now asserts dispatch
  ordering instead of a wall-clock bound.
- [`review-preparation.md`](../architecture/review-preparation.md) covers
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
