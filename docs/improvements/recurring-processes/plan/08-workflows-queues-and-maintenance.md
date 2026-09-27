# 08 — Schedule workflow and queue work by key and deadline

Status: Implemented with unit/integration and driven-harness qualification;
real-stack (isolated profile, live providers) qualification remains for step 12
— see [Completion notes](#completion-notes). Dependencies: 02, 07; step 11
before slower reconciliation. Finding: F06.

## Outcome

Completed/inactive records stop dominating frequent supervisor scans. New work,
provider transitions and result commits wake only relevant owners. Durable
records still recover every pending obligation after a crash or missed wakeup.

## Existing sources

- `build-pipeline-service-base.ts`, `build-pipeline-service-supervisor.ts` and
  related recovery/fan-out modules.
- `looped-review-service.ts`, `multi-review-service.ts`, `feature-planning.ts`.
- `native-agent-service-reconciliation.ts`, `native-agent-service-prompt.ts`,
  `prompt-queue-drainer.ts`, `storage-native.ts` and workflow storage modules.
- `agent-mail-service.ts`, `coordinator-service.ts`, `index.ts` and lifecycle
  command handlers.

## Implementation tasks

1. Define the set of runnable or recoverable obligations for each domain. Do not
   equate runnable with a phase named `running`: include cancelling, recovering,
   terminal usage/result settlement, pending result consumptions, interactive
   Fix completion, durable address handoff, parked dispatch reconciliation,
   launch retry, interrupted teardown and pending rename.
2. Introduce a rebuildable index of active/pending keys and due times, maintained
   only after successful durable mutations. Prefer existing storage revision
   metadata and active-list APIs. Keep indexes bounded; page large startup
   discovery rather than materializing every historical transcript/package.
3. On startup, load authoritative records, validate them and rebuild scheduling.
   Retain existing migration/adoption and terminal-reconciliation behavior.
   A failed record must not block unrelated recovery, but a failed enumeration
   must not be mistaken for proof that all work completed.
4. Add scoped wakeups for start/resume/retry/cancel, queue enqueue, provider
   transition, accepted workflow result, environment readiness and changed
   execution identity. Subscribe before capturing the initial scan and reconcile
   changes that race startup. Prevent write/observe feedback loops through
   revision checks and idempotent domain operations.
5. Migrate feature planning first because it already lists active records; then
   build pipeline, looped review and multi review in separate review units.
   Each retains its locking, lease fencing, result validation, dispatch journal
   and structured-output deadlines. Keep existing fallback cadence initially.
6. Apply bounded workflow admission across different keys. A single slow provider
   must not hold a service-wide tick open and delay unrelated due work. Preserve
   per-workflow serial progression and ensure nested reviewer fan-out has its
   own budget without recursively exhausting the same admission pool.
7. Convert poll-count deadlines into explicit elapsed deadlines where cadence
   changes would alter semantics. Examples include missing-result grace and
   bounded final-usage probes. Preserve intentional attempt limits separately
   from time limits; changing a one-second tick must not silently turn a
   five-poll grace into minutes or shorten it to a burst of immediate wakeups.
8. Keep 5-second renewal of 15-second review leases on a separate critical path.
   Renew only held leases and release after terminal work settles. A scheduler
   delay or lost lease fences further mutations; it never permits a second owner
   to act on stale authority. Avoid unnecessary snapshot rewrites during renewal
   where the storage contract already separates ownership metadata.
9. Migrate native/tmux queues and launch/rename intent to due keys. Enqueue and
   turn-end wakeups already exist in places; fill missing coverage and preserve
   one queued dispatch per idempotency key. An ambiguous dispatch remains parked
   until explicit positive reconciliation, retry under the same key, or discard.
10. Separate the `index.ts` activity bundle into named due jobs: activity,
     tmux queue fallback, presence, mail injection, coordinator notification
     repair, mail retention and renames. Reuse observation snapshots from step
     07. Preserve each current overlap guard during migration.
11. Replace `% 30` tick-count maintenance with elapsed deadlines. Trial coarser
     retention only after measuring cost and defining acceptable retention lag.
     Keep tab teardown/orphan cleanup at its already-coarse minute cadence unless
     evidence calls for change; preserve its one-hour orphan grace.
12. Once wakeup/recovery tests pass, slow broad discovery to a measured 30–60 s
     safety interval while active jobs keep responsive due deadlines. Use
     content-free counters to prove historical record counts no longer multiply
     fast-tick deep validation. Retain a full diagnostic reconciliation route.

## Required tests

For each migrated service, compare transitions from the same persisted fixture
under old and new scheduling. Include many completed records and a few active
ones; pending terminal obligations; missed events; restart between durable commit
and wakeup; failed storage enumeration; corrupt record; cancellation during a
slow provider read; lease renewal under saturation; stolen/expired lease;
interactive Fix handoff; simultaneous queue enqueues; ambiguous prompt response;
and invalidation arriving while a job is running.

Prove a periodic tick alone cannot sustain an endless immediate-rerun chain,
while a real dirty event causes a fresh pass. Verify startup returns without
waiting for an indefinitely active scheduler. Test all work with no renderer,
then rehydrate on another client after completion.

## Acceptance and rollback

Fast work selection scales with due/active obligations, not retained historical
workflow bodies. Durable side effects happen once under existing fences and
leases. A missed wakeup converges within the documented safety interval. Rollback
returns one domain at a time to its old driver using the same records; disable
the new driver before enabling the old one. Rebuildable indexes can be discarded
without losing authoritative state.

## Completion notes

Recorded 2026-09-26. One commit per review unit, each domain individually
revertible:

| Unit | Commit |
| --- | --- |
| Keyed workflow supervisor, elapsed poll gate, result wakeups, rollback switch | `72b1a64f` |
| Feature planning | `c8dce7c0` |
| Build pipeline | `c01e666d` |
| Looped review (critical lease renewal) | `9a00525e` |
| Multi review | `4e65a011` |
| Native launch intents and prompt queues | `5e74f662` |
| `index.ts` activity bundle split, elapsed maintenance | `0d8e13d4` |
| Broad discovery slowed to a 30 s safety interval (task 12) | `0a18501f` |
| Driven workflow baseline | `cd1bc998` |

### What landed

- **`KeyedWorkflowSupervisor`** (`apps/backend/src/core/workflow-supervisor.ts`)
  on the step 02 `RecurringScheduler`: a rebuildable, bounded index of keys
  that still owe work, each progressed on its own due time with one run per
  key, plus a separate authoritative discovery pass. Keys are noted only
  after successful authoritative reads and fenced saves; `start()` returns
  without waiting for the first pass; a failed or partial enumeration never
  drops known obligations; a corrupt record is skipped without blocking
  others. Wake reasons are a finite set (`start`, `resume`, `retry`,
  `cancel`, `enqueue`, `provider-transition`, `result-accepted`,
  `environment-change`, `storage-change`, `explicit`). Real changes
  invalidate (one trailing pass while running); `provider-transition` and
  `environment-change` are hints that only pull a due time forward, so a
  periodic tick alone cannot chain reruns and a domain that writes on every
  pass does not wake itself. Passes run under the `workflow-provider`
  admission pool (per-target bound, nested hand-off for reviewer fan-out);
  lease renewal runs on the scheduler's separate critical pool.
- **Obligations (task 1)** are named per domain, not inferred from a phase
  called `running`:
  - Feature planning: every active phase (exchange/readiness/reply waits),
    nothing terminal. Discovery keeps using `listActiveFeaturePlanning`.
  - Build pipeline: result consumption in any phase, provisioning, review
    fan-out, stage progression, terminal side effects. A terminal pipeline
    that still owes a result consumption is now finished without a restart.
  - Looped review: result consumption in any phase, cancelling, prepared
    dispatch, awaiting result, phase start, legacy adoption. A parked
    ambiguous dispatch owes nothing until an explicit retry/discard.
  - Multi review: result consumption, cancellation, durable interactive Fix
    handoff, paused-stop retry, interactive Fix observation, reviewers,
    single step (`multi-review-scheduling.ts`, shared by every driver).
  - Native queues: a queue owes work while pending or holding a reserved
    in-flight head; parked (including unreconciled ambiguous dispatch),
    empty and tmux queues owe nothing. Launch intent is one recovery job.
- **Scoped wakeups (task 4)**: workflow-result acceptance (post-commit hook
  on `WorkflowResultService`), environment readiness/execution-identity
  changes, provider transitions, enqueue/turn-end and queue mutations,
  deletion events (retire a key at once) and explicit commands.
- **Elapsed deadlines (task 7)**: `ElapsedPollGate` keeps attempt-counted
  graces and final-usage probes (build reviewers, looped missing-result
  grace, multi-review idle-result/final-usage at 3 s spacing) meaning the
  same wall time: a burst of wakeups cannot exhaust them, and a slowed
  cadence cannot stretch them.
- **Leases (task 8)**: the 5 s renewal of held 15 s review leases runs on the
  critical pool and keeps its deadline while every best-effort pass is
  blocked on a provider; a stolen lease is dropped and fences further writes.
  Lease-only writes no longer rotate snapshot backups.
- **Activity bundle (tasks 10–11)**: `BackendActivityJobs`
  (`backend-activity-jobs.ts`) replaces the 2 s `setInterval` and the 60 s tab
  timer. Native activity sweep, Claude terminal state, tmux queue fallback,
  mail presence, mail injection and pending renames are separate fixed-rate,
  non-overlapping 2 s jobs, so a hung sweep no longer delays the presence
  refresh behind the 4 s presence TTL. Coordinator notification repair, mail
  retention and tab teardown/orphan cleanup run on their own elapsed 60 s
  deadlines instead of `% 30` of the activity tick (one-hour orphan grace
  unchanged). Each operation keeps its instrumentation and overlap guard.
  Queue and environment changes pull the tmux and rename jobs forward.
- **Safety interval (task 12)**: authoritative discovery for feature
  planning, build pipelines, looped and multi reviews and native
  queues/launches drops from the per-tick listing (1–2 s; 15 s for multi
  review) to `DEFAULT_WORKFLOW_DISCOVERY_MS` = 30 s, while every key with an
  obligation keeps its 1–1.5 s (or due-time) progress cadence. Rename intent
  runs every 2 s only while one is pending, otherwise 30 s, and is woken by
  environment changes. 30 s is the low end of the trial range: a missed
  wakeup converges within it (tested), and nothing measured argued for
  accepting a longer worst case. The full diagnostic reconciliation route is
  `reconcile_workflow_scheduling`, which also reconciles the native queue
  index.

### Rollback

`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` takes a comma-separated list of
domains (`feature-planning`, `build-pipeline`, `looped-review`,
`multi-review`, `native-queues`, `backend-activity`) or `all`. It is read
once at construction, so a domain runs exactly one driver: the new driver is
never started when the old one is selected. Indexes are discarded on
rollback; durable records, dispatch journals and leases are untouched.
`multi-review` rollback restores the adaptive due scheduler; its
`adaptiveScheduling: false` option still selects the legacy tick.

### Before / after (driven harness)

`apps/backend/scripts/recurring-baseline-workflows.ts` drives the real
feature-planning, build-pipeline and looped-review supervisors over a real
temporary store with 200 completed and 2 active records per store for 10
minutes, in rollback (whole-store tick) and keyed modes. The artifact's
`workflows` block (see `baseline/step-12-final.json`):

| Domain | Mode | Attempts | Records scanned | Storage reads | Provider reads |
| --- | --- | --- | --- | --- | --- |
| Feature planning | rollback | 600 | 0¹ | 1,800 | 1,200 |
| Feature planning | keyed | 1,223 | 4,242 | 1,223 | 1,202 |
| Build pipeline | rollback | 400 | 80,800 | 1,200 | 800 |
| Build pipeline | keyed | 823 | 4,242 | 823 | 802 |
| Looped review | rollback | 600 | 121,200 | 6,604 | 1,200 |
| Looped review | keyed | 1,223 | 4,242 | 6,035 | 1,202 |

¹ Feature planning already listed active records only, so its rollback scan
count is not charged as retained history.

Records scanned now scale with active obligations plus one 30 s discovery,
not with retained history: −95 % for build pipelines and −96.5 % for looped
reviews at 200 completed records, and the gap grows with history. Attempts
roughly double because each active key is its own short pass rather than one
whole-store tick; each pass reads only its own record, so storage reads fall
(−32 % feature planning, −31 % build, −9 % looped review). Provider reads are
unchanged within one pass per active key, as required — progress cadence was
not slowed. Multi review is not driven (its idle cost depends on active
workflows; see the harness limitations).

### Tests

`workflow-supervisor.test.ts` (selection scales with obligations; settled
keys dropped; slow key isolation; dirty-vs-periodic reruns; self-write loop;
lost wake during probe; missed wakeup converges within the safety interval;
restart between durable commit and wakeup; failed enumeration; corrupt
record; start returns while a pass hangs; admission bound and nested
hand-off; critical jobs on time under a full best-effort pool; scoped wakes;
`reconcileNow`; rollback switch per domain; content-free status; elapsed
gate against bursts and slowed cadence). Per domain: old and new drivers make
the same transitions from one persisted fixture (feature planning, build
pipeline, looped review); retained history only read by discovery;
cancellation during a slow provider read; lease renewal under saturation;
stolen lease; missing-result grace under a wakeup burst; interactive Fix and
runnable-state classification (multi review); simultaneous enqueues dispatch
once; backoff honoured; parked ambiguous dispatch stays parked; enqueue by
another writer found by discovery (native queues); fixed-rate jobs, elapsed
maintenance and error isolation (`backend-activity-jobs.test.ts`), plus
`index.test.ts` wiring. All pass on the integration branch; aggregate results
are recorded in step 12.

### Not done / untested constraints

- No live isolated-profile run with real providers: zero-renderer workflow
  completion and rehydration on another client are covered by unit and
  integration tests only (step 12 records what was run).
- Multi review is not driven by the harness.
- Coarser mail retention (task 11's optional trial) was not attempted;
  retention runs on the same 60 s elapsed deadline as before.
