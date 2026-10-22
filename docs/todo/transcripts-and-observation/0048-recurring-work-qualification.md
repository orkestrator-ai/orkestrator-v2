# Recurring work qualification

Checked against `main` at `2459b05c` (2026-10-15).

#852 changed how often the app collects and reads facts: shared worktree
snapshots, a container fetch policy, lifecycle-aware PR monitoring, the client
read coordinator, the native observation broker and keyed workflow
supervision. It was qualified only on Linux, with deterministic call counts
and one credential-free idle A/B run. Before the rollback drivers can go, the
instrumentation that would distort live evidence needs fixing, live freshness
and cost need measuring against the written latency budgets, and the measured
candidates need a decision.

## Current state

- Recorder: `recurringWorkMetrics` (`apps/backend/src/core/recurring-work-metrics.ts`)
  labels work only by the kinds in `RECURRING_JOB_CATALOGUE`
  (`packages/protocol/src/recurring-work.ts`), whose `inventory` field carries
  the B, C and L IDs of the inventory in
  [recurring-work.md](../../architecture/recurring-work.md).
- Read through `get_recurring_work_diagnostics` (`commands-registry-system.ts`)
  and the `recurringWork` block of the gateway's `/__orkestrator/metrics`.
- Harness: `apps/backend/scripts/recurring-baseline.ts` with its `-harness`,
  `-native` and `-workflows` modules; flags `--out`, `--compare`,
  `--fail-on-change` and `--overhead`. It drives real owners on a manual clock
  and counts calls; `apps/backend/tests/recurring-baseline.test.ts` keeps it
  deterministic. Method and scenario matrix:
  [testing-guide.md](../../development/testing-guide.md#recurring-work-harness);
  latency budgets:
  [recurring-work.md](../../architecture/recurring-work.md#latency-budgets).
  No reference artifact is committed (the stored step artifacts stopped
  reproducing after the efficiency file-tree cache and the storage move, and
  were deleted), so generate one before any comparison. The workflows block
  reports `storageReads` beside `storageStats`, and the test holds each
  attempt to a per-domain storage budget (`STORAGE_PER_ATTEMPT`).
- Rollback switches, each read once at startup and let through the desktop
  environment allowlist in `apps/desktop/electron/backend-process.ts`:
  - `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` (`KEYED_SCHEDULING_ROLLBACK_ENV`,
    `workflow-supervisor.ts`): a comma list of `feature-planning`,
    `build-pipeline`, `looped-review`, `multi-review`, `native-queues`,
    `backend-activity`, or `all`. A named domain runs its old whole-store
    driver instead of the keyed one; `multi-review` falls back to
    `WorkflowDueScheduler`.
  - `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0` (read in `core/index.ts`).
  - `ORKESTRATOR_RECURRING_METRICS=0` turns the recorder off.
- Multi review also keeps `adaptiveScheduling: false` (the legacy 1 s tick)
  and `evidencePermits` in `MultiReviewServiceOptions`; their removal is owned
  by [0027-multi-review-scale-and-cost.md](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md).
- Trial constants: `DEFAULT_PR_MONITOR_POLICY` (terminal discovery 5 min plus
  30 s jitter), `CONTAINER_FETCH_COOLDOWN_MS` (5 min) and
  `CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS` (30 min),
  `DEFAULT_ADMISSION_POOL_LIMITS` (`git-docker-scan` 4 total and 1 per target,
  `external-pr` 2 and 1, `workflow-provider` 8 and 2),
  `DEFAULT_WORKFLOW_DISCOVERY_MS` (30 s) and `NATIVE_QUIET_BACKOFF_TRIAL_MS`.
- `HostSuspendDetector` re-times every live scheduler after a host sleep so
  overdue keys run once.

## Outstanding work

### Code: instrumentation, before the live profile

1. Charge the storage reads that still bypass the counters.
   `StorageDatabase.rows()` charges nothing; display tails, build-pipeline
   transcript manifests, deletion fences and web annotations read through it.
   Nor does a hit in the workflow-result entry index
   (`workflow-result-service.ts`), which is revalidated by store revision.
   Charge each as a `storage-read` or `storage-stat` under the storage
   accounting rule in "Constraints and rationale". Also decide whether rows
   fetched from the database should charge `bytes`, so the live profile can
   tell a cache miss (a full row fetch) from a cache-served read. Both count
   as one `storage-read` today.
2. Decide the 19 catalogue kinds built with `external(...)` (renderer, bridge
   and desktop work). They are `instrumented: false`. Record them with
   bounded, content-free counters, or drop them from the vocabulary.
3. Count OpenCode SDK requests as `provider-request`; today only
   `http-bridge-transport.ts` charges it. Decide whether direct `fs` reads
   outside `loadJson` (draft buffers, Kanban images) count as storage reads.
4. Drive multi review in `recurring-baseline-workflows.ts`. Only feature
   planning, build pipelines and looped review are driven.
5. Commit the live idle A/B procedure as a script or as documented commands;
   the qualifying run used an uncommitted wrapper. Generate a fresh reference
   artifact only when a cadence change needs one; a run takes seconds.
6. Bring `RECURRING_JOB_CATALOGUE` and the harness text back in line with the
   code:
   - `acp-disconnect-poll` (L07) still lists a 50 ms poll, but ACP disconnect
     detection is event-only (`bridges/acp-bridge/src/acp-client-disconnect.ts`).
     Remove the kind or mark it historical.
   - `client-browser-annotation` (C13) lists a 150 ms poll that no longer
     exists; annotation capture now polls `SELECTION_POLL_MS` (400 ms) while
     selecting, in `useAnnotationCapture.ts`.
   - `coordinator-repair` is catalogued `recovery` but registered as
     `maintenance` in `core/index.ts`; pick one.
   - `BASELINE_LIMITATIONS` in `recurring-baseline-harness.ts` still says
     multi review uses the adaptive due scheduler by default (it is keyed).

### Qualification

Use isolated profiles (`../development/agent-testing.md`). Runs that need
credentials or a platform CI lacks are batched in
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

- Live isolated profile, started with
  `mise run dev:test --profile <name> --fixture --fixture-environments local,container`:
  - 10 environments with 0, 1 and 2 browser clients; at least five minutes of
    warm idle, then burst saves, long Git reads, an active turn, a pending
    approval, a queued prompt, a workflow completion, a network outage and a
    client resume;
  - sample `recurringWork` and process CPU/RSS every 30 s, and record p50/p95
    change-to-visible against the latency budgets;
  - CPU/RSS with metrics on and off; three repeats; a window longer than the
    5 min container fetch cooldown;
  - container app wiring: the Files panel open on a container, a merge from
    the UI and an inactive-environment switch;
  - the rollback arm sets `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=all` and
    `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0`. Stop and reset with
    `mise run dev:stop` and `mise run dev:reset`.
- Live GitHub: terminal discovery cadence, replacement and reopen discovery,
  admission queue delay under real `gh` latency, and rate-limit cooldown.
- Live providers: see [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md).
- macOS: watcher coverage with recursive `fs.watch` (`worktree-watcher.ts`;
  only Linux was exercised, other platforms use the polling fallback),
  Electron and Docker Desktop.
- iOS: the `apps/ios` wrapper running the web client, checking the read
  coordinator's hidden pause and resume across backgrounding and screen lock.
- A real host suspend and resume against `HostSuspendDetector`.
- Soak: repeated add, remove, stop and restart cycles. Timer, subscriber and
  cache counts return to baseline, and profile logs hold zero
  `Unhandled promise rejection (continuing)` guard lines.
- Two clients with one disconnected; backend and bridge restarts at durable
  transition boundaries; an older backend.
- Real-browser QA of the Files panel (inactive-environment switch, two
  windows, hidden document, reload, missed final invalidation), the
  coordinator view, validation output and hidden-document reconcile.

### Measured candidates

Decide each from the live data; change nothing without evidence.

- Settled check-rollup backoff (`pr-check-rollup`, 60 s).
- A container-scoped PR cooldown. It is per entry today because container
  credential scope cannot be proven from the backend.
- The container fetch failure ladder (5 to 30 min), tuned from
  `git-fetch-container` metrics.
- The admission pool limits.
- Raising the priority of a queued discovery scan when an interactive read
  joins it; `WorkAdmissionPool` has no re-prioritisation.
- A coarser `mail-retention` deadline (60 s today).
- Sharing Docker availability across clients
  (`DOCKER_AVAILABILITY_POLL_INTERVAL_MS`, 60 s, `apps/web/src/App.tsx`).
- A longer quiet interval for the design canvas cursor check
  (`DESIGN_CANVAS_CURSOR_CHECK_MS`, 3 s, `design-controller.ts`), after
  missed-final-hint recovery is qualified.
- One shared visible display clock for `useElapsedTimer` and
  `usePromptDeadline` (not profiled).
- The validation reader's in-environment `bun` spawn per poll.
- Demand gating for interactive tmux capture (B19, `tmux-interactive.ts`).
- Splitting the validation worker's 500 ms liveness write from changed-result
  writes (B20, `review-validation-worker.ts`), only with cross-process
  crash-recovery and cancellation proof.
- A keyed row read for feature planning's per-record pass. `getFeaturePlan`
  (`storage-kanban.ts`) decodes the whole feature-plan store on every pass, so
  a pass costs O(plans) rather than O(row); the workflows block shows one
  whole-store read per keyed attempt.

### Code: after soak

- Remove `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and the whole-store drivers
  domain by domain, with the desktop allowlist entry. Remove the
  `multi-review` domain together with `WorkflowDueScheduler`, which
  [0027-multi-review-scale-and-cost.md](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md) deletes.
- Remove `ORKESTRATOR_NATIVE_OBSERVATION_SHARING` and its allowlist entry.
- Decide whether `ORKESTRATOR_RECURRING_METRICS` stays as a permanent off
  switch.
- Update the affected `RECURRING_JOB_CATALOGUE` entries in the same change.

## Constraints and rationale

Scheduling architecture, kept from the plan:

- The backend, bridge or external process stays authoritative. Browser demand
  affects presentation reads and optional sampling, never execution or durable
  delivery.
- Scheduler mechanics stay separate from domain decisions.
  `RecurringScheduler` knows keys, deadlines, priority and capacity; PR
  lifecycle, workflow phases, approvals and dispatch journals stay in domain
  services.
- Active indexes and due jobs are rebuilt from durable state at startup.
  Scheduling is in memory; there is no second durable job database.
- Events give prompt reaction; authoritative snapshots reconcile. Reducing a
  safety interval needs explicit missed-event recovery evidence.
- Observation stays separate from attach, hydrate, dispatch and touch.
  Background observers never keep idle threads resident or start bridges.
- Prefer joining equivalent reads over caching results longer. Keys include
  connection and generation, target, identity, options and revision;
  credential-sensitive scopes never share results.
- Older backends and bridges keep working through capability negotiation and
  conservative fallback. A network or auth error is not proof that a
  capability is missing.
- The critical class (lease renewal, approval and auth expiry, watchdogs)
  is never queued behind best-effort work.
- In-process deadlines use monotonic elapsed time; durable expiry keeps
  wall-clock semantics. After a sleep, overdue work reconciles once and missed
  ticks are never replayed.
- No distributed queue, mandatory webhook server, extra database or single
  scheduler spanning backend, bridges and browser. A GitHub webhook
  integration or a container-side watcher may be a later measured experiment;
  both add lifecycle, authentication and recovery duties.

Obligations the keyed drivers must keep when the old drivers go:

- Obligations are named per domain, not inferred from a `running` phase.
  Feature planning owes every active phase. Build pipelines owe result
  consumption in any phase, provisioning, review fan-out, stage progression
  and terminal side effects. Looped review owes result consumption,
  cancelling, prepared dispatch, awaiting result, phase start and legacy
  adoption; a parked ambiguous dispatch owes nothing until an explicit retry
  or discard. Multi review's list is shared by every driver in
  `multi-review-scheduling.ts`. A native queue owes work while pending or
  holding a reserved in-flight head; parked, empty and tmux queues owe
  nothing.
- Wakeups come from workflow-result acceptance, environment readiness and
  identity changes, provider transitions, enqueue and turn-end, queue
  mutations, deletions and explicit commands, with a 30 s discovery pass as
  the safety net.
- A terminal PR entry re-verifies every terminal obligation from storage
  (environment PR state, task status, link, comment and completion flag,
  merge-cleanup intent) before going quiet. The only runtime marker is
  `settledTerminal`; nothing durable claims "all effects done". Transition
  toasts are best-effort and never replayed.

Qualification and rollout:

- No savings claim without live numbers, and no savings percentage promised in
  advance. A migration that adds complexity without measurable benefit is
  reverted or deferred.
- A cadence change must hold its latency budget and record p50/p95 against it.
  Exceeding a budget must be accepted explicitly. Terminal PR discovery
  (within 5 min plus immediate explicit and completion wakes) is the one
  accepted slowdown.
- Never shadow `gh`, Git or provider reads at production scale, and never
  shadow a workflow mutation or prompt dispatch. Measurement must not add the
  load it measures.
- Roll back one policy at a time: disable the new driver before enabling the
  old one, then reconcile once. Indexes and caches may be rebuilt; dispatch
  journals and workflow results must survive. The PR terminal cadence rolls
  back by setting `terminalDiscoveryIntervalMs` to 20 s and
  `terminalDiscoveryJitterMs` to 0 in `DEFAULT_PR_MONITOR_POLICY`.
- Recurrent guard-caught unhandled rejections count as a failure.
- For every background feature: start work in environment A, switch to B, let
  A progress, return, verify transcript, status, pending prompts and controls,
  reload, and verify again. Repeat with two clients and one disconnected.
- `RECURRING_JOB_CATALOGUE` describes the system as it is: a cadence or policy
  change updates its entry in the same change, and the code cites the
  inventory's B, C and L IDs.

Storage accounting, settled at `9906db30`:

- Storage is charged by what the caller got, not where the rows came from.
  A `storage-read` is stored content decoded for a caller (a whole store, one
  owner's rows or one row), even when the connection's revision-validated
  row cache serves it. A `storage-stat` is a revision or stat check that
  reuses values already decoded: a write diffing against cached rows,
  `storeRowStats`, the build-pipeline control-record and live-tag caches, and
  the file stat cache. A database fetch for an internal lookup is still a
  read. `StorageDatabase` reports `read` or `stat`, and `storage-context.ts` maps
  them one to one.
- Why: the counter exists to catch extra reads. A cached whole-store read
  still parses every row, and whether the cache is warm depends on unrelated
  writes, so a physical-fetch count cannot catch a pass that reads twice.
  The rejected alternative kept a cache hit as a `storage-stat` beside
  physical reads. An extra whole-store read would then show only as a stat,
  and `storageReads` would stay near zero for whole-store readers.
- The `cache-hit` attribution only partly explained the drop. At `9906db30`,
  before the fix, the default workflows block (200 completed, 2 active,
  10 min; rollback/keyed) read feature planning 0/0, build pipelines 4/4 and
  looped review 6,005/6,015. Its stats were 1,800/1,223, 5/10 and 601/22.
  The #852 artifact read 1,800/1,223, 1,200/823 and 6,604/6,035. So
  `cache-hit` explains feature planning exactly and looped review to within 2
  (its other reads are keyed row reads). It does not explain build pipelines.
  Their reads moved into the decoded control cache (`buildPipelineReadCache`)
  that #875 added, whose hits charged nothing. They dropped at #875, not
  #969. "`storageReads` = 0 in both modes" was true only of feature planning.
- After the fix, the same block reads feature planning 1,800/1,223, build
  pipelines 8/12 with 1,203/827 stats, and looped review 6,606/6,037. That
  matches #852 apart from the build-pipeline split and a few startup reads.
  Storage counts do not grow with retained history. Injecting one extra
  cache-served read into `getFeaturePlan` takes rollback feature planning to
  450 against its budget of 270.

## Open questions

- Are about three weeks of soak since #852 (2.19.x to 2.20.0) enough to retire
  the rollback drivers, or does retirement wait for the live profile?
- Should the Claude terminal-state poll (B18, in
  [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md)) be
  measured first, since it dominates remaining container idle cost?

## Needs verification

- Whether open flake [0177](../../tests/flaky-tests/native-agents-and-transcripts/0177-driven-observation-baseline-timeout.md)
  (`recurring-baseline.test.ts` timeout) is load-only.

## Related

- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md),
  [0051-client-reconnect-and-freshness.md](0051-client-reconnect-and-freshness.md) and
  [0052-remote-client-bandwidth.md](0052-remote-client-bandwidth.md): the client and
  observation halves of #852.
- [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md): B18, the
  container Files panel status exec and `containerRevertFileCommand`'s inline
  fetch.
- [0027-multi-review-scale-and-cost.md](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md): the
  multi-review rollback gates and benchmark.
- [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md):
  activity-sweep latency against real bridges.
- [0043-web-annotation-known-limitations.md](../previews-and-annotations/0043-web-annotation-known-limitations.md):
  annotation capture polling (`SELECTION_POLL_MS` in `useAnnotationCapture.ts`)
  belongs there, not here.
- [recurring-work.md](../../architecture/recurring-work.md) for the inventory
  (B, C and L IDs), scheduling primitives and latency budgets, and
  [testing-guide.md](../../development/testing-guide.md#recurring-work-harness)
  for the harness method and scenario matrix.
- Living-doc drift to fix: several modules carry "recurring-processes step
  NN" provenance comments that point at deleted plans; harmless.

## Replaces

- `docs/improvements/recurring-processes/plan/00-index.md` (deferral list;
  architecture decisions and trial policy carried into "Constraints and
  rationale")
- `docs/improvements/recurring-processes/plan/01-baseline-and-measurement.md`
  (live profile and instrumentation gaps)
- `docs/improvements/recurring-processes/plan/02-scheduling-and-admission.md`
  (done; trial-limit tuning)
- `docs/improvements/recurring-processes/plan/03-shared-worktree-snapshots.md`
  (qualification, macOS watcher, re-prioritisation; container read cost is in
  `container-state-observation.md`)
- `docs/improvements/recurring-processes/plan/04-container-git-fetch-policy.md`
  (app qualification, failure ladder; the inline revert fetch is in
  `container-state-observation.md`)
- `docs/improvements/recurring-processes/plan/05-pr-monitoring-policy.md`
  (live GitHub evidence, rollup backoff, container cooldown, rollback)
- `docs/improvements/recurring-processes/plan/06-client-read-coordination.md`
  (real-stack QA)
- `docs/improvements/recurring-processes/plan/08-workflows-queues-and-maintenance.md`
  (rollback drivers, multi review in the harness, mail retention)
- `docs/improvements/recurring-processes/plan/09-secondary-client-processes.md`
  (Docker availability, design canvas, display clock, validation reader)
- `docs/improvements/recurring-processes/plan/12-qualification-and-rollout.md`
  (gaps, rollback switches, soak)
- `docs/improvements/recurring-processes/baseline/README.md` (latency budgets
  and trial limits moved to `../architecture/recurring-work.md`, harness
  method to `../development/testing-guide.md`; the live isolated profile
  procedure is above)
- `docs/improvements/recurring-processes/baseline/step-01-baseline.json`
- `docs/improvements/recurring-processes/baseline/step-03-snapshots.json`
- `docs/improvements/recurring-processes/baseline/step-04-container-fetch.json`
- `docs/improvements/recurring-processes/baseline/step-05-pr-monitoring.json`
- `docs/improvements/recurring-processes/baseline/step-07-baseline.json`
- `docs/improvements/recurring-processes/baseline/step-12-final.json`
- `docs/imrovements/recurring-processes.md` (inventory moved to
  `../architecture/recurring-work.md` with current cadences; findings F01 to
  F10 shipped; B19 and B20 are measured candidates above; B18 is in
  `container-state-observation.md`)
