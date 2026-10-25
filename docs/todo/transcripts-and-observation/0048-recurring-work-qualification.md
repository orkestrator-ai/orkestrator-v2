# Recurring work qualification

Checked against `main` at `00a0cb82` (2026-10-25). Live evidence from macOS
on 2026-10-22 and 2026-10-25; see
[Live evidence](#live-evidence-2026-10-22-macos) and
[Live soak](#live-soak-2026-10-25-macos).

#852 changed how often the app collects and reads facts: shared worktree
snapshots, a container fetch policy, lifecycle-aware PR monitoring, the client
read coordinator, the native observation broker and keyed workflow
supervision. It was qualified on Linux with deterministic call counts and one
credential-free idle A/B run. The instrumentation fixes are done and a
credential-free macOS idle A/B with freshness probes has run. What remains is
the busy live profile, the GitHub, provider, iOS, suspend and soak runs, the
measured-candidate decisions those runs feed, and then removing the rollback
drivers. On 2026-10-25 the feature-planning keyed row read landed (the one
candidate the deterministic harness could decide), keyed row reads began
reusing a warm row cache, `stableJitterMs` moved out of the rollback-only
file, the live A/B script gained a lifecycle soak, flake 0177 was resolved,
and the decisions below were recorded.

## Current state

- Recorder: `recurringWorkMetrics` (`apps/backend/src/core/recurring-work-metrics.ts`)
  labels work only by the kinds in `RECURRING_JOB_CATALOGUE`
  (`packages/protocol/src/recurring-work.ts`), whose `inventory` field carries
  the B, C and L IDs of the inventory in
  [recurring-work.md](../../architecture/recurring-work.md). Only
  backend-recorded work has a kind. The 19 renderer, bridge and desktop kinds
  that nothing recorded were dropped from the vocabulary (with them the stale
  `acp-disconnect-poll` 50 ms and `client-browser-annotation` 150 ms
  entries), and the inventory's C and L rows describe that work by ID.
- Storage accounting follows the rule in "Constraints and rationale" on
  every path. Uncached `StorageDatabase.rows()` queries are `storage-read`s,
  and a workflow-result entry index hit is a `storage-stat`. Every
  `openBackendDatabase` connection reports, not only `StorageService`'s.
  Content fetched from the database charges its serialized length as `bytes`
  (`observeFetch`), so a cache miss shows bytes beside its read and a
  cache-served read shows none. Terminal session buffers and Kanban images
  are blob files: `file-read`s with bytes, not storage reads.
- Keyed row reads (2026-10-25): feature planning's per-record pass reads its
  plan as one row (`getFeaturePlan` uses `loadStoreRow`, `storage-kanban.ts`),
  not the whole feature-plan store. `StorageDatabase.readStoreRow` takes the
  row from the connection's row cache when that cache holds the committed
  revision, so a warm keyed read fetches nothing; a miss fetches the one row
  and leaves the cache alone. Looped and Multi Review row reads gain the same.
- OpenCode SDK clients fetch through `openCodeSdkFetch`
  (`http-bridge-transport.ts`): the provider's default client
  (`createOpenCodeSdkClient`, `opencode-sdk-client.ts`), the host catalogue
  refresh and provider sign-in. Each SDK request, event-stream connects and
  reconnects included, is a `provider-request` like a `bridgeFetch`.
- The activity jobs `coordinator-repair`, `claude-state-reconcile` and
  `pending-rename-reconcile` register as `recovery`, as catalogued (they were
  `maintenance`, `progress` and `progress`). In `BackendActivityJobs` the
  class only orders overdue runs after a host resume: every job has its own
  slot.
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
  No reference artifact is committed; generate one before any comparison.
  The workflows block drives feature planning, build pipelines, looped review
  and multi review (its rollback is the real `WorkflowDueScheduler`, on the
  harness's manual clock since 2026-10-25). It reports `storageReads`
  beside `storageStats` and `storageBytes` (what those reads fetched from
  SQLite, since 2026-10-25), and the test holds each attempt to a per-domain
  storage budget (`STORAGE_PER_ATTEMPT`). The harness now closes each
  temporary `StorageService` before deleting its directory. Before that fix a
  run logged `Hourly database snapshot failed: disk I/O error` and its process
  stayed alive for minutes after the work finished.
- Live idle A/B: `scripts/recurring-live-ab.ts`, documented in
  [testing-guide.md](../../development/testing-guide.md#live-idle-ab). Since
  2026-10-25 `--soak-cycles N --soak-environments local,container` adds a
  lifecycle soak: each cycle creates, starts to `ready`, stops, restarts and
  deletes one environment per kind through the CLI. It compares a
  content-free footprint (scheduler keys per owner and kind, admission
  leases, fetch and signal records, running jobs, event-stream and terminal
  subscribers) before and after, counts guard lines, and exits 1 on a failed
  step, a leaked gauge or a guard line (`soakFootprint`, `soakLeaks` in
  `recurring-live-ab-summary.ts`).
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
- Multi review's own rollback gates (`adaptiveScheduling: false`, the legacy
  1 s tick, and `evidencePermits`) were removed on 2026-10-25 by
  [0027-multi-review-scale-and-cost.md](../coordinator-and-multi-review/0027-multi-review-scale-and-cost.md).
  Only the `multi-review` domain of the switch above and its
  `WorkflowDueScheduler` remain.
- Trial constants: `DEFAULT_PR_MONITOR_POLICY` (terminal discovery 5 min plus
  30 s jitter), `CONTAINER_FETCH_COOLDOWN_MS` (5 min) and
  `CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS` (30 min),
  `DEFAULT_ADMISSION_POOL_LIMITS` (`git-docker-scan` 4 total and 1 per target,
  `external-pr` 2 and 1, `workflow-provider` 8 and 2),
  `DEFAULT_WORKFLOW_DISCOVERY_MS` (30 s) and `NATIVE_QUIET_BACKOFF_TRIAL_MS`.
- `HostSuspendDetector` re-times every live scheduler after a host sleep so
  overdue keys run once.
- `stableJitterMs` lives in `multi-review-scheduling.ts` (moved 2026-10-25),
  which the keyed driver and the `WorkflowDueScheduler` rollback share, so
  removing `multi-review-scheduler.ts` no longer touches the keyed path.
- Container fetch reach (found 2026-10-25): every new container records its
  creation commit before setup (`establishCreatedFromCommit`,
  `commands-local-server-lifecycle.ts`), and `resolveComparisonRef`
  (`packages/protocol/src/diff-stats.ts`) prefers that commit. A container's
  diff baseline is therefore a full commit SHA, which the status script
  classifies as `commit` and the policy never fetches. The routine fetch
  policy reaches only environments with no `createdFromCommit` (older records,
  or a start whose capture failed). Missing-baseline recovery and explicit
  refreshes still fetch.

### Harness effect (2026-10-25)

`--compare` against an artifact generated from the same tree before the
storage changes (with the new `storageBytes` field, so only real changes
show) moved five counters, all bytes; every count, read and stat is
unchanged. Default fixture (200 completed, 2 active, 10 min), rollback/keyed
`storageBytes`:

| Domain | Before | After |
| --- | --- | --- |
| Feature planning | 0 / 0 | 0 / 0 |
| Build pipelines | 25,844 / 25,844 | 25,844 / 19,383 |
| Looped review | 14,134,620 / 14,157,570 | 3,128,420 / 3,665,450 |
| Multi review | 7,723,120 / 8,532,320 | 1,435,470 / 1,630,630 |

Feature planning fetched nothing before or after because its row cache is
warm, but a cached whole-store read still parsed every plan. A direct
benchmark over 202 small plans with a warm cache measured `getFeaturePlan`
at 3.9 to 4.3 µs per pass against 80.0 to 81.9 µs for the whole-store read and
find it replaced (three runs of 2,000 passes each), so a pass now costs one
row. Looped and Multi Review row reads now come from the warm cache instead
of a SQLite query, a 4 to 5 times drop in bytes fetched.

### Harness effect (2026-10-22)

`--compare` against an artifact generated at `b83ae534` moved only the
workflows block. Build-pipeline storage reads rose from 8 to 24 in rollback
and from 12 to 24 keyed: the startup sweep's transcript-manifest row
listings, now charged. The new multi-review domain read as follows at
the default fixture (200 completed, 2 active, 10 min): rollback 600 ticks,
11,400 storage reads and 2,400 provider reads; keyed 361 attempts, 3,421
reads and 680 provider reads. A keyed pass reads its record ten times
(one-row reads and `validateMultiReviewController` fence checks); a
whole-store tick reads 19 times with two active workflows. Every scenario
counter is unchanged. The base artifact itself read keyed build pipelines as
18/829, not 12/827, during a run slowed to 16 minutes by heavy disk
contention and the unclosed-storage linger. Two direct runs at the base
commit gave 12/827, so that domain's full-matrix counts are not reliable
under load. The full matrix now takes about 30 s.

### Live evidence (2026-10-22, macOS)

Host: macOS (Darwin 25.6.0, arm64), Docker Desktop 29.7.2, Bun 1.4.3, a
`dev:test` build of this branch. `scripts/recurring-live-ab.ts` ran three
repeats of three arms (candidate, rollback, metrics off). Each run was a fresh
fixture profile with one local and one container environment and no agent
credentials, settled for 60 s and was sampled every 30 s over a 6-minute
window. No browser client was attached, so the Electron window was the only
client; its title-bar meter is the `system-usage-sample` row. Starts per minute,
mean of three repeats (every repeat within ±0.1):

| Job | Rollback | Candidate |
| --- | --- | --- |
| Feature planning tick | 59.9 | 2.0 |
| Looped review tick | 59.9 | 2.0 |
| Build pipeline tick | 39.9 | 2.0 |
| Multi review tick | 4.0 | 2.0 |
| Native launch scan | 30.0 | 2.0 |
| Native queue scan | 30.0 | 2.0 |
| Pending rename reconcile | 30.0 | 2.0 |
| Native activity sweep, mail presence and injection, Claude state, tmux drain | 30.0 each | 30.0 each |
| Claude terminal-state poll (1 container) | 59.9 | 59.9 |
| Diff scans (1 local watched, 1 container) | 4.5 | 4.5 |
| Container git fetch | 0 | 0 |

- Work units per minute: candidate 76.8 storage reads and 96.0 stats,
  rollback 132.7 and 133.9. `docker exec` was 63.9 in both arms, 59.9 of it
  the container's terminal-state poll (B18), and Git spawns were 4.0. The
  fixture stores are empty, so the saving is wakeups and launch and rename
  scans, not workflow history. The ratios match the Linux run of #852.
- Process cost per repeat, backend process only. CPU in ms per minute:
  candidate 245, 250 and 262; rollback 248, 277 and 250; metrics off 253,
  245 and 292. RSS median: 163 to 263 MiB in every arm, with no trend by arm.
  The Electron process tree used 645 to 730 ms/min (repeats 2 and 3; repeat 1
  sampled only the launcher wrapper). At this idle load neither the keyed
  drivers' saving nor the recorder's cost shows above the run-to-run spread.
- Freshness, measured backend-side from the write to the `diff-scan`
  `changed` counter moving. This is a lower bound on change-to-visible.
  - Watched local worktree (recursive `fs.watch` on macOS): p50 516 ms and
    p95 739 ms over 15 probes per arm, the same in both arms. A later run with
    randomised probe offsets gave p50 649 ms and p95 872 ms over 12. Budget:
    2 s or less.
  - Container: 12 probes at random offsets in the 15 s poll gave p50 6.5 s,
    p95 13.4 s and a maximum of 13.4 s, including the `environment exec`
    write's round trip. Budget: 20 s or less. The 45 probes in the A/B runs
    used a fixed gap that phase-locked them to the poll (all 11.9 to 12.1 s),
    so only their maximum is meaningful.
- Zero `Unhandled promise rejection (continuing)` guard lines in each of the
  ten profiles' logs (the nine A/B runs and the freshness rerun), every one
  started, stopped and reset by the script.
- No container fetch ran. The fixture's environments use immutable commit
  baselines (`base.branch: null`), which never fetch, and the
  `container-git-fetch` policy held no records. The fetch policy and its
  failure ladder are therefore still unqualified live.

### Live soak (2026-10-25, macOS)

Host: macOS 27.0 arm64, Docker Desktop 29.9.2, Bun 1.4.4, a `dev:test` build
of this branch on a shared host (load average 12 to 15 from other work).
Command:

```bash
mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --settle-ms 60000 --window-ms 60000 --sample-ms 30000 --freshness-probes 0 \
  --soak-cycles 10 --soak-environments local,container --profile-prefix rw-soak \
  --out output/benchmarks/recurring-soak-2026-10-25.json
```

- The profile was ready after 46 s with the fixture's local and container
  environments. Ten cycles each created, started to `ready`, stopped,
  restarted and deleted one local and one container environment: 20
  environments, 100 CLI steps, 310 s. No step failed.
- Every footprint gauge returned to its baseline exactly: 8 schedulers and
  3 admission pools registered; scheduler keys 2 (agent observation), 11
  (maintenance) and 6 (workflows) with none settling; no admission lease
  active or waiting; container fetch 0 records and 1 container, signal
  sources 1 container each (the fixture's); no recorded job running; one
  event stream (the Electron window) and no terminal sockets. `soakLeaks`
  reported none.
- Zero `Unhandled promise rejection (continuing)` guard lines in the profile's
  four logs.
- Backend RSS was 175 MiB before the cycles and 238 MiB after the settle, one
  reading each. RSS is not a leak gauge here (Bun's heap grows and does not
  return memory promptly); a long soak has to show whether it plateaus.
- The script's final `dev:stop` exited non-zero although the profile had
  stopped (`dev:status`: `stopped`, nothing live), so it skipped the reset
  and left the fixture container running. `dev:reset` run by hand then
  removed one exact-owner container, two volumes and one network. The soak
  numbers are unaffected. If it recurs it needs its own todo against
  `dev:stop`.

## Outstanding work

### Qualification

Use isolated profiles (`../development/agent-testing.md`). Runs that need
credentials or a platform CI lacks are batched in
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

- Live isolated profile, started with
  `mise run dev:test --profile <name> --fixture --fixture-environments local,container`.
  The idle part is done on macOS (see Live evidence): 30 s samples, CPU/RSS
  with metrics on and off, three repeats, a window longer than the 5 min
  container fetch cooldown, a rollback arm, and backend-side freshness for a
  watched local and a container diff badge. Still owed:
  - 10 environments with 0, 1 and 2 browser clients, then burst saves, long
    Git reads, an active turn, a pending approval, a queued prompt, a workflow
    completion, a network outage and a client resume. Each needs credentials,
    a scripted UI or a fault injector that `recurring-live-ab.ts` does not
    have;
  - change-to-visible as a client sees it (the script stops at backend
    detection), for every row of the latency budgets;
  - the container fetch policy live. Narrowed 2026-10-25: a "branch-baseline
    container" cannot come from normal creation, because every new container
    records its creation commit and compares against it (see "Container fetch
    reach" above). What is still owed: a missing-baseline recovery fetch and an
    explicit refresh on a real container, and the routine policy on an
    environment without `createdFromCommit` (an older record, or a start
    whose capture failed). Whether the routine policy should stay at all is a
    decision for that run (see "Assumptions and decisions");
  - container app wiring: the Files panel open on a container, a merge from
    the UI and an inactive-environment switch.
- Live GitHub: terminal discovery cadence, replacement and reopen discovery,
  admission queue delay under real `gh` latency, and rate-limit cooldown.
- Live providers: see [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md).
- macOS: recursive `fs.watch` (`worktree-watcher.ts`) detects a save in a
  watched worktree in under 1 s (Live evidence), with Electron under
  `dev:test` and Docker Desktop. Still owed: a packaged Electron app, and the
  watcher's burst-overflow and failure-to-polling paths on macOS.
- iOS: the `apps/ios` wrapper running the web client, checking the read
  coordinator's hidden pause and resume across backgrounding and screen lock.
- A real host suspend and resume against `HostSuspendDetector`.
- Soak: repeated add, remove, stop and restart cycles. Timer, subscriber and
  cache counts return to baseline, and profile logs hold zero
  `Unhandled promise rejection (continuing)` guard lines. The ten idle
  profile lifecycles of 2026-10-22 had zero guard lines each; that is not a
  soak. 2026-10-25: the driver exists (`--soak-cycles`, see Current state)
  and a first 10-cycle local and container soak ran (see
  [Live soak](#live-soak-2026-10-25-macos)). Still owed: a long soak (at least
  50 cycles over an hour or more, with agent sessions open), and cache
  counts the footprint cannot see yet (worktree snapshot and row caches have
  no diagnostics gauge).
- Two clients with one disconnected; backend and bridge restarts at durable
  transition boundaries; an older backend.
- Real-browser QA of the Files panel (inactive-environment switch, two
  windows, hidden document, reload, missed final invalidation), the
  coordinator view, validation output and hidden-document reconcile.

### Measured candidates

Decide each from the live data; change nothing without evidence. The
2026-10-22 idle A/B decides none of them. It has no PRs, no GitHub, no
fetching container, a single client, no design canvas, no validation output
and no interactive terminal, so every candidate below except the
feature-planning row read (decided from the deterministic harness on
2026-10-25) is still open. The container fetch failure ladder needs the
routine policy to run first, which new containers never do (see "Container
fetch reach").

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
- ~~A keyed row read for feature planning's per-record pass.~~ Done
  2026-10-25: `getFeaturePlan` reads one row, and a warm keyed read is served
  from the row cache. Evidence: harness counts unchanged, bytes in "Harness
  effect (2026-10-25)", 3.9 to 4.3 µs against 80.0 to 81.9 µs per pass over
  202 plans, and `storage-read-accounting.test.ts` ("a feature-planning pass
  reads its plan's row, not the whole store").

### Code: after soak

Not started. The idle A/B on macOS shows the keyed drivers starting no more
often than the rollback drivers, with the same freshness and no guard lines.
But the busy profile, live GitHub, providers and soak above have not run, so
the rollback drivers stay.

- Remove `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` and the whole-store drivers
  domain by domain, with the desktop allowlist entry. Remove the
  `multi-review` domain together with `WorkflowDueScheduler`
  (`multi-review-scheduler.ts` and its test). Since 2026-10-25 nothing else in
  Multi Review depends on it, and `stableJitterMs` has moved to
  `multi-review-scheduling.ts` (done 2026-10-25; its test moved with it), so
  deleting the file is now self-contained. Waits for the busy live profile
  (see "Assumptions and decisions").
- Remove `ORKESTRATOR_NATIVE_OBSERVATION_SHARING` and its allowlist entry.
- ~~Decide whether `ORKESTRATOR_RECURRING_METRICS` stays as a permanent off
  switch.~~ Decided 2026-10-25: it stays, as a permanent diagnostic kill
  switch rather than a rollback driver (see "Assumptions and decisions"). On
  the 2026-10-22 idle A/B the recorder's cost did not show above run-to-run
  spread (backend CPU 245 to 262 ms/min with it on, 245 to 292 with it off).
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
  read. `StorageDatabase` reports `read` or `stat`, and `storage-stores.ts` maps
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

Both questions were answered on 2026-10-25; see "Assumptions and decisions".

- ~~Are about three weeks of soak since #852 enough to retire the rollback
  drivers, or does retirement wait for the live profile?~~ It waits for the
  busy live profile.
- ~~Should the Claude terminal-state poll (B18) be measured first?~~ Yes, in
  [0020-container-state-observation.md](../containers-and-environments/0020-container-state-observation.md),
  which owns B18. On the macOS idle A/B it was 59.9 of 63.9 `docker exec`
  calls per minute, in both arms.

## Needs verification

- ~~Whether open flake 0177 (`recurring-baseline.test.ts` timeout) is
  load-only.~~ Verified 2026-10-25: load-only, and resolved. The case costs
  about 1 s on this host; half its wall time was 480 clamped `setTimeout(0)`
  waits, which stretch under load. The tick now yields with `setImmediate`
  (identical counts on both fixtures, 1284 to 1347 ms → 785 to 881 ms per
  run) and the case has an explicit 30 s timeout. Evidence in
  [0177](../../tests/flaky-tests/native-agents-and-transcripts/0177-driven-observation-baseline-timeout.md#resolution--2026-10-25).

## Assumptions and decisions

Recorded 2026-10-25 by the worker that implemented this file's code items.

1. **Rollback driver retirement.** Options: retire now on about three weeks
   of production use since #852; or wait for the busy live profile (live
   GitHub, providers, a long soak). Chosen: wait. Why: the only live data is
   an idle, credential-free profile and a 10-cycle soak. Neither exercises an
   active turn, a workflow completion or PR monitoring, which are exactly
   the obligations the keyed drivers must keep, and the constraints below say
   to roll back one policy at a time with evidence. Pros: the switch stays a
   one-variable rollback if a busy-profile bug appears. Cons: two code paths
   per domain stay, and the rollback drivers keep needing upkeep. To make the
   eventual removal cheap, `stableJitterMs` moved now.
2. **`ORKESTRATOR_RECURRING_METRICS`.** Options: delete it with the rollback
   drivers; or keep it as a permanent off switch. Chosen: keep. Why: it is a
   kill switch for diagnostics, not a scheduling rollback. It costs one
   startup read and a branch per record, and its recorder cost was not
   measurable above run-to-run spread on the idle A/B. If the recorder ever
   faults or costs more on a busy profile, it is the only way to rule it out
   without a rebuild. Pros: a cheap safety valve; A/B arms stay possible.
   Cons: one more environment variable in the desktop allowlist, and a path
   (metrics off) that only the A/B exercises.
3. **B18 first.** Options: measure the Claude terminal-state poll before
   the other candidates; or keep it in queue order. Chosen: measure it first,
   in its owning file 0020. Why: it was 59.9 of 63.9 `docker exec` calls per
   minute per idle container in both arms, far above everything this file
   still lists. Pros: the largest remaining idle cost is decided first.
   Cons: none here; the work belongs to 0020.
4. **Feature-planning keyed read without live data.** The measured
   candidates say "change nothing without evidence". Options: wait for a busy
   live profile; or take the harness and a benchmark as the evidence.
   Chosen: implement. Why: the change is a read-path optimisation with no
   cadence or policy change, so it has no latency budget to hold. The
   deterministic harness proves its counts are unchanged, and the benchmark
   proves the per-pass cost (one row against every plan). Pros: O(row)
   passes. Cons: none measured; a keyed read takes a SQLite query when the
   cache is cold, which is the cost every other keyed read already pays.
5. **Keyed row reads from a warm cache.** Options: always query the one row;
   or take it from the connection's row cache when that cache holds the
   committed revision. Chosen: the cache when warm, and a one-row query
   otherwise that does not fill the cache. Why: without it, moving
   `getFeaturePlan` to a row read would have turned zero bytes fetched per
   pass (warm whole-store cache) into one row per pass. The revision is read
   in the same transaction as the cache check, and every write path already
   clears or replaces the cache, so correctness is unchanged; the accounting
   rule (a read is a read, bytes only for fetched content) still holds.
   Pros: looped and Multi Review passes fetch 4 to 5 times fewer bytes. Cons:
   a keyed read's bytes now depend on whether some other reader warmed the
   cache, as whole-store reads already did.
6. **Container fetch policy qualification.** The "branch-baseline
   container" sub-item assumed the fixture could make one. Every new
   container compares against its creation commit, so it cannot. Options:
   add a fixture hack that clears `createdFromCommit`; narrow the item to
   what real environments can reach; or remove the routine policy. Chosen:
   narrow it, and leave removing or keeping the routine policy to the run
   that qualifies it. Why: clearing a durable field through a side door would
   qualify a state users only reach by an old record or a failed capture, and
   removing a policy needs the evidence this file asks for. Pros: no test-only
   backend surface. Cons: the routine path stays unqualified live.
7. **Soak driver placement.** Options: a new script; or a phase of
   `recurring-live-ab.ts`. Chosen: a phase (`--soak-cycles`). Why: the A/B
   script already owns the profile lifecycle, the ownership checks before any
   destructive command, the signal handling and the guard-line count; a
   second script would copy all of it. Pros: one tested lifecycle. Cons: the
   script grows, and a soak always runs after an (optionally short) sampling
   window.
8. **Soak leak rule.** Options: compare single samples; or compare the
   highest of three readings before against the lowest of three after a
   settle. Chosen: the latter. Why: running jobs, due keys and admission
   leases move every few seconds, so a single sample would report a job that
   happens to be running as a leak. A real leak survives every reading.
   Pros: no false alarms from transient work. Cons: a leak smaller than the
   baseline's own swing is hidden until it grows; a long soak shows it.
9. **Flake 0177 timeout.** Options: only remove the timer clamp; only raise
   the timeout; or both. Chosen: both. Why: the clamp was a real share of the
   wall time and its removal keeps the counts identical, but the case still
   spins up four real on-disk stores, and isolated failures happened at load
   averages this host reaches routinely. Its sibling workflow baseline
   already carries 60 s for the same reason. Pros: no more load-only
   failures; assertions are unchanged. Cons: a real hang now takes 30 s to
   fail instead of 5.
10. **Provenance comments.** The "recurring-processes step NN" comments that
    point at deleted plans span about 60 sites in web, backend and test
    files. Options: sweep them now; or leave them. Chosen: leave them, except
    in the files this change already touched. Why: they are harmless, and a
    cross-area sweep collides with parallel work for no behaviour change.
    Pros: a small, reviewable diff. Cons: the drift stays.

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
