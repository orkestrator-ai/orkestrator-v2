# Recurring background work

Status: Living — who owns each recurring job, its cadence, the scheduling
primitives and the freshness budgets cadence changes are held to.

Orkestrator does a lot of work on a clock or in response to hints: PR polls,
diff scans, workflow passes, agent observation, renderer refreshes, bridge
keepalives. This note is the map of that work. The backend, a bridge or the
external process stays authoritative; browser demand only affects
presentation reads and optional sampling, never execution or durable
delivery. Outstanding qualification, measured candidates and rollback-switch
removal are tracked in
[0048-recurring-work-qualification.md](../todo/transcripts-and-observation/0048-recurring-work-qualification.md).

## Vocabulary and diagnostics

`packages/protocol/src/recurring-work.ts` is the shared, dependency-free
vocabulary:

- `RECURRING_JOB_KINDS` names every job the backend records. A kind is the
  only label a recurring-work metric may carry; an environment id, path,
  branch, URL, prompt or command output can never become a dimension.
  Renderer, bridge and desktop recurrence has no kind: nothing records it,
  and an entry nothing records drifts unnoticed. The C and L tables below
  describe it by ID. A process that starts recording adds its kinds, with a
  bounded, content-free path to the diagnostics surface.
- `RECURRING_JOB_CATALOGUE` records, per kind, the trigger, priority class,
  nominal cadence, in-flight policy, recovery contract and whether the backend
  records it today (`instrumented`). Its `inventory` field holds the IDs used
  in the tables below (B for backend, C for client-driven backend reads, L01
  for the gateway heartbeat; `F02` marks the container fetch policy). The
  catalogue is descriptive: nothing reads a cadence from it to drive a timer,
  and a cadence or policy change updates its entry in the same change.
- `RECURRING_WORK_UNITS` counts physical work (`git-spawn`, `gh-spawn`,
  `docker-exec`, `directory-read`, `provider-request`, `storage-read`,
  `record-scanned`, …) at the boundary that performs it, attributed to the
  innermost recurring job. `storage-read` counts stored content decoded for a
  caller, whether the database or its revision-validated row cache served it,
  and every uncached row query; `storage-stat` counts a revision or stat check
  that reused values already decoded. Content fetched from the database also
  charges `bytes`, so a cache miss is visible beside a cache-served read (see
  [storage.md](storage.md)). `provider-request` is one HTTP request to a
  bridge (`bridgeFetch`). Requests to an OpenCode server (`OpenCode2Client`)
  are not counted; until 2026-11-11 the OpenCode 1.x SDK's `openCodeSdkFetch`
  counted them, event-stream connects included.

The backend recorder, `recurringWorkMetrics`
(`apps/backend/src/core/recurring-work-metrics.ts`), keeps one fixed record
per kind (requested, coalesced, started, completed, failed, rejected,
changed/unchanged, cache hits, bytes, duration and queue-delay histograms,
work units, error categories) and tracks at most
`RECURRING_WORK_MAX_TRACKED_ACTIVE` (1,024) in-flight attempts. Errors are
recorded as finite categories, never messages. `ORKESTRATOR_RECURRING_METRICS=0`
turns it off. A few backend kinds are catalogued but not yet recorded
(`instrumented: false`).

`recurringWorkDiagnostics()` (`recurring-diagnostics.ts`) is the one
read-only surface: recorder snapshot, every live scheduler, admission pool,
fetch policy and container change signal (`signals`: per-state counts of the
Claude state and worktree signals, how many containers run their fallback
cadence, and demotions by reason) and native session invalidations
(`sessionInvalidations`: counts by content-free cause and by platform, from
`native-session-invalidation-metrics.ts`, plus `discoveryRenewals`: discovery
announcements by platform and section with the value paths that changed,
such as `value[].tools[order]`, structural names only), all aggregate and
content-free. It is served by the
`get_recurring_work_diagnostics` command and the `recurringWork` block of the
gateway's `/__orkestrator/metrics`.

`caches` reports the in-memory caches nothing else counts, so a soak can tell
a cache that tracks live environments and sessions from one that grows with
every one ever seen. Owners register a source with `addCacheSource(name,
source)` while they live, and the registry sums sources of one name:

| Name | Owner | Gauges |
| --- | --- | --- |
| `storage-row-cache` | each open `StorageDatabase` connection (`openBackendDatabase`, the change ledger) | `connections`, `stores`, `rows`, `bytes` (serialized length) |
| `worktree-snapshots` | `DiffStatsTracking` | diff-stats entries, file-tree lineages and retained bodies, ad hoc reads, and the tracker's per-environment maps |
| `local-git-scan` | `DiffStatsTracking` (the module cache) | `worktrees`, `counts` |
| `native-projection` | `NativeAgentService` | the size of every per-session map of the transcript projection, and the bytes its bounded caches charge |
| `change-tracking` | `ChangeTrackingService` | worktree owners, evidence sources, pending pulls and deleted-environment fences |

Field names are compiled-in identifiers: the registry drops any field that is
not a short lowercase identifier or not a finite, non-negative number, keeps
at most 64 fields per name and 32 sources per name, and counts a throwing
source in `faultedSources`. Reading a gauge walks memory only.

## Scheduling primitives

Scheduler mechanics stay separate from domain decisions. A scheduler knows
keys, deadlines, priority and capacity; PR lifecycle, workflow phases,
approvals and dispatch journals stay in the domain services. Scheduling is in
memory and rebuilt from durable state at startup; there is no second job
database.

**Priority classes** (`RECURRING_PRIORITY_CLASSES`, most urgent first):
`critical` (lease renewal, approval and authentication expiry, watchdogs;
own concurrency, never queued behind anything else), `interactive` (a user is
waiting), `recovery` (repairs durable obligations; reserved capacity),
`progress`, `discovery` and `maintenance`.

**`RecurringScheduler`** (`apps/backend/src/core/recurring-scheduler.ts`) runs
keyed recurring work for one owner (`worktree-snapshots`, `pr-monitor`,
`agent-observation`, `workflows`, `maintenance`):

- one run per key, including across re-registration;
- the next due time is computed when a run settles, so a slow run cannot
  build a backlog;
- `requestSooner` only pulls a due time earlier and is dropped while the key
  runs; `invalidate` while running queues exactly one trailing run;
- jitter applies to soft deadlines only and is bounded; hard deadlines are
  never jittered;
- one timer for the earliest due time; after a sleep or clock jump each
  overdue key runs once, in priority order, and missed ticks are not
  replayed;
- registered keys, concurrent runs and waiting keys per class are bounded.
  Exhaustion is an explicit rejection, and a refused hint marks the key
  `reconcileRequired` so its next run does an authoritative read;
- every run gets an `AbortSignal` and an `isCurrent()` fence; a slot is
  released only when the run's promise settles. `dispose` is bounded.

**`WorkAdmissionPool`** (`work-admission.ts`) bounds expensive work across
targets, with fair waiting and a starvation limit:

| Pool | Concurrent | Per target | Used by |
| --- | --- | --- | --- |
| `git-docker-scan` | 4 | 1 | Diff scans, Files-panel list and tree reads, container fetches |
| `external-pr` | 2 | 1 | PR detection and check rollups |
| `workflow-provider` | 8 | 2 | Keyed workflow passes |

`WorkAdmissionPool` has no re-prioritisation: an interactive read that joins
a queued discovery scan waits at the scan's priority.

**`HostSuspendDetector`** (`host-suspend-detector.ts`) compares wall-clock and
monotonic progress. In-process deadlines are monotonic, so on resume it
reports the lost time once and every registered scheduler re-times its due
work. Durable expiry keeps wall-clock semantics.

**Keyed workflow supervision** (`workflow-supervisor.ts`). Feature planning,
build pipelines, multi review, graph runs and native prompt queues keep one
due key per record that owes work, instead of listing the whole store each
tick. Wakeups come from workflow-result acceptance, environment readiness and
identity changes, provider transitions, enqueue and turn end, queue
mutations, deletions and explicit commands; a 30 s discovery pass
(`DEFAULT_WORKFLOW_DISCOVERY_MS`) is the safety net. An incomplete discovery
adds what it found but never drops a key. Obligations are named per domain,
not inferred from a `running` phase.

A model submits a workflow result through a tool call inside its turn, so the
acceptance and its `result-accepted` wake always land before that turn can
end, and the turn's end raises no wake: workflow sessions are not native agent
sessions, so the activity sweep never reports a `provider-transition` for
them. A pass that reads the turn still running would otherwise leave the
result for the next observation pass (3 s plus jitter). Multi Review therefore
schedules its next pass after 250 ms (`RESULT_SETTLE_POLL_MS`) while a
tool-mode result it observes (the active step's, or a running reviewer's) is
accepted but not consumed, for one observation interval from the acceptance;
past that window the ordinary cadence applies, so a model that keeps working
after submitting cannot hold the short cadence (todo 7557, retired
2026-11-10; `multi-review-result-settle.test.ts`). Graph runs read their turns
the same way and follow the same rule (todo 7564, retired 2026-11-11;
`graph-run-result-settle.test.ts`): a `graph-output` acceptance marks the
owning activation, and while it still reports running its next observation
comes after 250 ms (`GRAPH_RUN_RESULT_SETTLE_MS`), without the per-run spread,
for one observation interval from the acceptance.

A Multi Review validation run is a detached worker in the environment, and
nothing announces its end either. While a run started less than one
observation interval ago is still running, the workflow reads it on the fast
cadence (1 s, `VALIDATION_FAST_WINDOW_MS`), so a run of about a second reaches
`reviewing` about a second after it ends rather than at the next 3 s
observation pass; a longer run pays at most two extra status reads before the
ordinary cadence applies (todo 7564; `multi-review-result-settle.test.ts`).

**Native observation broker** (`native-agent-observation.ts`). The backend's
activity sweep is the only observer of provider activity. Prompt-queue
drains, agent mail, the coordinator and workflows read its bounded,
content-free observation instead of issuing their own provider reads.
Observation uses the no-touch `/activity` route; it never starts a bridge,
attaches, hydrates or refreshes liveness. Dispatch and generation fences make
a pre-dispatch idle inert. A provider group whose sessions are all stably
idle backs off to a 4 s safety read (`STABLE_IDLE_BACKOFF_MS`) only when the
provider has a qualified wakeup for work started elsewhere: OpenCode's
`/api/event` stream while it is connected (`observationStreamLive`,
`opencode2/environment-provider.ts`), and the Claude and Codex bridges' content-free observation
stream (`/event/subscribe?observe=1`, `http-bridge/observation-stream.ts`).
Cursor, Pi and Grok groups are read on every sweep. Mail presence reports a
retained idle the injection gate would not trust (older than 4 s, or read
before the latest dispatch) as `unknown`. See
[event-snapshot-recovery.md](event-snapshot-recovery.md) for the stamped
session-activity and content announcements.

**Client read coordinator** (`apps/web/src/lib/read-coordinator.ts`, used via
`useCoordinatedRead`) owns renderer presentation reads: one timer per read
key with the fastest active demand winning, joining of equivalent in-flight
reads, a single trailing read per invalidation burst, and `refresh()` that
always waits for a read started after the call. Automatic reads pause while
the document is hidden or a transport has declared itself disconnected (the
browser gateway's main stream, or Electron's active connection; see
`transport-connectivity.ts`), and
visibility, focus, page-show, online and reconnect signals are coalesced for
50 ms and reconciled once, critical keys first; that reconcile also restarts
every quiet backoff, so a backed-off key reads at once if its base cadence is
overdue. Failed reads back off and keep the last good value as stale. The
coordinator never owns prompt submission, approval resolution, workflow
progress or queue draining.

**Data saving** is a client-local preference (Settings > General, stored with
the client's UI state in `uiStore`) fed to the coordinator as one more
scheduling input (`setDataSaving`, wired by `lib/data-saving.ts`). Each read
may name a `dataSaving` variant of its demand; while the preference is on the
coordinator uses it in place of the base interval or quiet backoff. It never
slows invalidations, explicit refreshes, resume or reconnect reconciles, and
it never changes another client's cadence or anything the backend runs. A
read that sees a change outside the coordinator (an announced revision, a
checkpoint, a mutation) calls `noteActivity()` to restore its base cadence.
Variants today: C01 running/blocked/cancelling/recovering 1 s; C02 quiet
backoff through 10, 15 and 30 s on a watched worktree, 10 s otherwise; C05
quiet backoff through 8, 15 and 30 s. These are trial values, measured live in
[remote-bandwidth.md](../development/remote-bandwidth.md#data-saving-in-real-browsers-2026-11-11).

### Rollback switches

Each is read once at startup and allowed through the desktop environment
allowlist in `apps/desktop/electron/backend-process.ts`:

- `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` (`workflow-supervisor.ts`): a comma
  list of `feature-planning`, `build-pipeline`, `graph-run`, or `all`. A named
  domain runs its old whole-store driver. `graph-run` has no previous driver:
  rolling it back disables graph runs (launches are refused, nothing
  advances; stored runs stay readable and can be cancelled). `multi-review`,
  `native-queues` and `backend-activity` are no longer revertible: their
  rollback drivers (Multi Review's adaptive `WorkflowDueScheduler`, the 2 s
  timer over every environment and queue, and the 2 s activity bundle with
  its 60 s tab timer) were removed after the busy live profile and the long
  soak (todo 0048 task 13), so naming them, or `all`, leaves them on their
  keyed drivers.
- `ORKESTRATOR_NATIVE_OBSERVATION_SHARING=0`: every consumer reads providers
  itself again.
- `ORKESTRATOR_RECURRING_METRICS=0`: the recorder is off.

## Inventory

Cadences are the shipped defaults. "Join" means a concurrent request awaits
the running attempt.

### Backend

| ID | Kind(s) | Owner | Cadence and policy |
| --- | --- | --- | --- |
| B01, B02 | `pr-detection`, `pr-check-rollup` | `pr-monitor.ts`, `pr-monitor-policy.ts`, `commands-pr-monitor.ts` | Completion-scheduled per environment: 20 s normal, 5 s create-pending (reverts after 10 min), 1 s merge-pending (reverts after 20 s). Errors double the interval up to 5 min. Restored entries are spread over one normal interval. Terminal (merged or closed) PRs repair their side effects from storage, then rediscover replacement or reopened PRs every 5 min plus up to 30 s jitter, with immediate wakes on explicit refresh and agent completion. Open PRs read the check rollup at most once per 60 s. Rate limits cool down for 2 min. `external-pr` pool. |
| B03 | `diff-scan` | `diff-stats-service.ts`, `worktree-watcher.ts`, `container-worktree-signal.ts` | Watched local worktree: hints settle for 400 ms, plus a 120 s safety scan; an ignored `node_modules` sends none (see [git-scan-caches.md](git-scan-caches.md#what-the-worktree-watch-leaves-out)). Container with a confirmed worktree signal: a scan per ring, at most one per 2 s, plus a 60 s safety scan (see [container-lifecycle.md](container-lifecycle.md#container-worktree-signal-container-worktree-signal1)). Other containers and unwatched worktrees: 15 s poll. A periodic tick is skipped if any scan started within half an interval. Failures back off 5 s to 60 s; a failed watcher retries 30 s to 10 min, five times per streak, and falls back to polling. A streak ends only once a re-attached watcher has held qualified coverage for 10 min. A watcher that meets an unreadable directory stays open but unqualified, so the target polls without retrying (see [git-scan-caches.md](git-scan-caches.md#a-directory-the-backend-may-not-read)). A local worktree folder that is missing (deleted, moved, or on an unmounted drive) is checked with one `stat` before admission and runs no `git`: the attempt counts as `rejected`, never `failed`, the last counts stay stale, readers get "worktree folder is missing", the check repeats on the failure backoff, and `scan.target-missing` is logged once per streak. |
| B03 | `change-capture` | `change-tracking/worktree-owner.ts`, `turn-boundaries.ts` | Not periodic. Turn start/end and restore captures run through the shared `git-docker-scan` pool at `interactive` priority, at most one per worktree, two remote at a time; provisional captures of a running turn follow watcher hints at most every 1 s locally / 5 s remotely. Boundary deadline 10 s, finalization 30 s. See [change-tracking.md](change-tracking.md). |
| B06 | `change-evidence-pull` | `change-tracking/service.ts` | Rides the 2 s activity sweep: after a bridge connection is observed, its change-evidence spool is pulled (single flight per connection; a bridge without the route is rechecked after 5 min). Each pull is its own attempt, so its read and acknowledgment are not charged to `native-activity-sweep`; a read with nothing new acknowledges its cursor only until the bridge has accepted that epoch and cursor once. Before 2026-11-11 the kind was never observed and every sweep read of a Claude session cost three bridge requests (activity, evidence read, a repeated ack), all charged to the sweep (todo 7567, retired 2026-11-11). |
| B03 | `change-retention` | `change-tracking/retention.ts` | Hourly: reference expiry, quota transitions and the object-store sweep with an orphan grace window. |
| B04 | `file-list-read`, `file-tree-read` | `DiffStatsService.readFileList` / `readTree` | Read-driven; joins the owner's scan. Watched worktrees answer from watched state until a hint. Unwatched file lists are reused for up to 3 s (`FILE_LIST_MAX_AGE_MS`). A container with a confirmed worktree signal is served like a watched worktree. Other container trees are reused for up to 10 s while a recent complete file list covers them, and re-walked at once when list membership changes. Revisions are described in [event-snapshot-recovery.md](event-snapshot-recovery.md). |
| B05 | `git-fetch-local` | `git-fetch-scheduler.ts` | Read-driven 5 min TTL per common Git directory and ref; concurrent fetches join; failures also stamp the cooldown. |
| F02 | `git-fetch-container` | `container-git-fetch.ts` | Separate from the status scan, which reads local refs only. 5 min attempt cooldown per container generation, clone and ref; failures back off 5, 10, 20 then 30 min; explicit refreshes at least 15 s apart; immutable local baselines never fetch; a missing ref gets one recovery fetch per window. A fetch that moves `origin/<ref>` triggers a rescan. Reverting a file in a container (`revert_container_file`) asks the policy for an inline fetch first (`refreshForAction`: like an explicit refresh, at most one per 15 s, in the container's admission slot); the revert script itself no longer fetches. |
| B06 | `native-activity-sweep` | `core/index.ts`, `native-agent-launch-activity-reconciler.ts` | Every 2 s, fixed rate; due provider groups only (see the observation broker). Eight workers, retry backoff, no-touch reads. A skipped (backed-off) group counts as a cache hit, a read group as a miss. |
| B07 | `native-launch-scan`, `native-queue-scan` | `native-agent-queue-scheduling.ts` | Keyed: 2 s while a launch intent or queued dispatch is pending (drain backoff 2 s to 60 s honoured), else a 30 s safety pass; enqueue, turn end and environment changes wake it. |
| B08 | `native-interaction-observe` | `native-agent-interaction-tracker.ts` | Every 2 s, only when the interaction monitor is `observe-only`. |
| B09 | `claude-state-reconcile`, `tmux-queue-drain`, `pending-rename-reconcile` | `core/index.ts` (`BackendActivityJobs`) | Each its own named job at 2 s fixed rate, never overlapping. Pending renames drop to a 30 s safety pass when none are pending. A failed first-prompt rename keeps its intent and backs off per environment: 30 s after the first failure, doubling to a 30 min cap (`pendingRenameRetryDelayMs`, `core/pending-rename-failure-log.ts`); a session's first prompt retries at once. It never gives up or falls back to a slug cut from the prompt: the backend cannot tell a refused login from an outage or see a later sign-in, and the name becomes a pushed branch, which raw prompt words must not reach. |
| B10 | `mail-presence`, `mail-injection` | `agent-mail-service.ts` | Resource changes coalesce for 250 ms; 2 s safety jobs. Observed presence lives 4 s, so the 2 s refresh must not be slowed on its own. A stale retained idle reads `unknown`; an `idle`/`unknown` flip does not reset the inject backoff. A presence pass reads the config once and each mailbox's environment once, and hands that row to the mailbox's delivery gate; before 2026-11-11 the listing read the config a second time and every running mailbox's gate re-read its environment (two extra rows and a second revision check a pass with two mailboxes, todo 7567, retired 2026-11-11). |
| B11 | `coordinator-repair`, `mail-retention` | `core/index.ts` | Own elapsed 60 s deadlines. Retention prunes mail older than `agentMessaging.retentionDays` (default 14). An independently guarded watched pull request sweep starts alongside repair, without holding its recovery promise (at most 15 GitHub reads, each PR at most every 2 min). |
| B12 | `activity-lease-expiry` | `core/index.ts`, `protocol/agent-activity.ts` | Every 15 s for a 30 s frontend activity lease. Critical. |
| B13 | `tab-cleanup` | `core/index.ts`, `tmux-commands.ts` | 60 s plus startup; teardown and orphan reaping each guarded in flight; orphans get a one-hour grace. The claude-tmux orphan sweep (`claude_tmux_reconcile_orphans`) costs up to five commands per environment (`tmux list-sessions`, the `ps` census behind an unreachable socket, and the hook removal's `test` and two `rm`), so it skips stopped containers and environments it last found quiet (nothing to reap or wait on, hooks verifiably removed; a failed restore or `rm` is retried next minute) until this backend starts a tmux session there, the environment moves to another container or worktree, or 30 minutes pass (`QUIET_ENVIRONMENT_RECHECK_MS`). An idle environment therefore costs one sweep after a backend start and one every 30 minutes, not five commands a minute (to-do 7531, retired). |
| B14 | `build-supervisor-tick` | `build-pipeline-service-lifecycle.ts` | Keyed: one pass per pipeline with an obligation every 1.5 s, 30 s discovery. A pass looks at a session's transcript only at the 5 s persist boundary, when a turn ends or while a stall warning shows, through a conditional progress probe; the whole body is read only when the probe moved since the committed copy, and always once when a turn ends (`refreshMovedTranscript`). |
| B16 | `multi-review-tick`, `multi-review-lease-renewal` | `multi-review-service.ts` | Keyed per-workflow 1 s passes, 30 s discovery; a running validation run is read every 1 s for its first 3 s, then on the 3 s observation cadence (todo 7564). Controller lease 15 s, renewed every 5 s (critical). The keyed driver is the only one: the legacy 1 s whole-store tick was removed on 2026-10-25, and the rollback `WorkflowDueScheduler` (the same per-workflow due times with a 15 s reconciliation scan) on 2026-11-10 (todo 0048 task 13). |
| B17 | `feature-planning-tick` | `feature-planning.ts` | Keyed per-record 1 s passes, 30 s discovery. A pass reads its plan as one row (`getFeaturePlan`), not the whole feature-plan store. |
| B18 | `tmux-poll` | `tmux-poll.ts` | One `docker exec` per read, change-only writes. On `claude-state-signal` images the hooks ring the backend, which reads on each ring plus a 30 s safety read (2 reads a minute idle); a change the safety read finds unannounced returns the container to 1 s. A container where terminal Claude never ran (no state file) also costs 2 reads a minute. Older images, and containers whose doorbell has not rung, keep the 1 s poll, which dominates their idle cost; recurring diagnostics count them (`signals`). See [container-lifecycle.md](container-lifecycle.md#claude-terminal-state-signal-claude-state-signal3). |
| B19 | `tmux-interactive-capture` | `tmux-interactive.ts` | Completion-scheduled 250 ms, doubling to 1 s while output is unchanged, per attached interactive terminal. Bounded line patches; exact screen recovery. A capture is one `tmux capture-pane`, or one `docker exec` in a container (about 60 to 70 ms of CPU on Linux, 2026-11-11). The loop stops on an explicit detach, the environment's tmux cleanup, shutdown, or (since 2026-11-11, to-do 7745, retired) a lapsed client lease: a renderer creates the terminal with `leased: true` and renews it every 15 s (`claude_tmux_renew_interactive_terminal`), and the backend detaches a leased terminal 45 s after its last renewal, so a reload, a closed window or a cut link no longer leaves a loop capturing for nobody. A terminal from an older renderer, which never announces a lease, still keeps capturing until one of the other three. Measured live in a container on 2026-11-11: an orphaned terminal added 57.5 captures (`docker exec`s) a minute; a leased one nobody renewed added none once its lease had passed ([testing guide](../development/testing-guide.md#a-claude-tmux-tab-in-a-container-and-per-item-counts-on-a-busy-profile)). Each timer capture is one attempt of this kind, its `docker exec` or tmux spawn charged to it. |
| B20 | `validation-heartbeat` | `review-validation-worker.ts` | 500 ms persistence and cancel heartbeat; 100 ms cooperative clock. Cross-process liveness, so partly correctness-related. |
| B21 | `storage-lock-heartbeat` | `storage-context.ts`, `storage-database.ts` | Lease holders heartbeat at least every third of the stale threshold. Critical. |
| B22 | `opencode-reconnect` | `opencode2/provider.ts` (`watchEvents`), `opencode2/stream-silence.ts` | The provider's `/api/event` stream; a lost connection is a gap: everything is re-read and the stream reconnects after 1 s. OpenCode 2 sends no heartbeat event, only a `: heartbeat` SSE comment on connect and every 15 s (measured on 2.2.6), so the comment arms the silence watchdog (`OpenCodeStreamSilenceWatchdog`), any bytes read count as life, and 50 s of silence (`OPENCODE2_EVENT_STREAM_SILENCE_MS`) aborts the connection onto the same loss path and logs it. Added by to-do 7559 (retired 2026-11-11). Until 2026-11-11 the OpenCode 1.x SDK stream (`git show 5f4e27b1c:apps/backend/src/core/opencode-observation-stream.ts`) backed off from 1 s to 30 s and used a 35 s deadline armed by `server.heartbeat`. |
| B23 | `bridge-observation-stream` | `http-bridge/observation-stream.ts` | One content-free `/event/subscribe?observe=1` connection per observed Claude or Codex bridge, opened by the sweep. Reconnect backs off from 1 s to 30 s with jitter and resumes from its cursor; a connection silent for 75 s is torn down. Connects, gaps and disconnects wake the whole group. An older bridge that does not confirm the mode is not reconnected. |
| B26 | `node-summary-reconcile` | `nodes/node-read-model.ts` | Named activity due job, every 60 s; reconciles connected node summaries and stops with the portal. |
| B27 | `scheduled-job-tick` | `scheduled-jobs/service.ts` | One timer for the earliest due fire, pending retry or stale heartbeat, capped at 30 s; woken by every schedule change in this process and by host resume. Fires only while the registry writer lease is held; claims are single-row transactions; at most four fires at once; a running fire heartbeats every 20 s. See [scheduled-jobs.md](scheduled-jobs.md). |
| B28 | `graph-run-tick` | `graph-run-service.ts`, `graph-run-supervisor.ts`, `graph-run-pass.ts` | Keyed per run with an obligation (`provision`, `cancel`, `observe`, `advance`, `await-human`), 30 s discovery. Running activations are observed every 3 s plus a stable per-run spread of up to 1 s (every 250 ms, with no spread, for one observation interval after one of their outputs is accepted while the turn still runs; todo 7564), admitting and provisioning runs every 1 s, a run waiting only for a person every 30 s. An accepted workflow result wakes only the run whose activation owns the slot; a released workspace lock wakes the environment's runs with ready work. Passes hold a `workflow-provider` slot (target: the run's environment) except while provisioning or waiting for a person; executor calls inside a pass are capped at 4 starting, 8 observing and 4 per provider. A pass reads only its run's row and writes only when something changed. |
| B29 | `machine-load-sample` | `machine-load.ts` | Every 60 s, fixed rate, first reading 15 s after start, on every backend whether or not anything reads it. Own job, stops with the backend; its timer is unref'd. One `os.cpus()` and one read of the shared RAM cache, so one `vm_stat` on a Mac unless the title bar's read is still fresh. Measured on an M-series Mac: `vm_stat` about 1.6 ms, `os.cpus()` under 0.01 ms; about 2.3 s of subprocess time a day. No GPU or disk probe. History is at most about 160 small buckets, in memory. See [coordinator.md](coordinator.md#choosing-a-machine). |
| B30 | `tmux-tab-loop` | `tmux-session-manager.ts` (`TmuxSession.spawnPollLoop`), `tmux-shared.ts`, `tmux-hook-signal.ts` | One loop per open claude-tmux tab, serial per tab. A tick every 250 ms while the tab is busy, 1 s idle, 2.5 s idle once its hook doorbell has rung. Each tick is one attempt: a snapshot (one `docker exec` in a container, tmux spawns locally) carrying the hook listing, liveness, pane and transcript size, plus, before the transcript binds, its backed-off search, and the hook drains and tail reads that follow. A tick that found hook files or transcript lines counts as changed. Before 2026-11-11 none of this was counted, so an open tab's container cost about twice what the counters showed (todo 7567, retired 2026-11-11). Not the per-container state poll, which is B18. |
| B31 | `public-operation-reconcile` | `public-api/reconciler.ts`, `public-api/run-observer.ts` | The public CLI's operation reconciler: a startup pass, a pass every 15 s, and a pass for the active operations of an environment that changed; a request during a pass queues one trailing pass. Each pass lists the active operations and observes each (a prompt run reads its environment, native session and turn activity). A run whose turn was seen to end with a later turn in its session is skipped (one `cacheHits` each; every observed operation is a `cacheMisses`) until its record changes, its environment is gone or the full pass every 10 min, and a client's `run get` always observes it (to-do 7562). Before 2026-11-11 the pass was not counted. Collection of retired namespaces rides the same timer, hourly. |
| C08 | `system-usage-sample`, `process-usage` | `commands-registry-system.ts` | Demand-driven by clients; concurrent reads join. A filesystem source (`statfs`, GPU sysfs) that does not answer in 1.5 s loses only its own figure, and its one hung call is kept rather than repeated (`createBoundedRead`). A stalled source logs `[host] usage.source-stalled` at warn (throttled, `scope=disk` or `scope=gpu-sysfs`), and its recovery once the last stalled source settles. |
| L01 | `gateway-heartbeat` | `gateway-handlers.ts` | Shared 25 s keepalive. It also advances the scoped stream cursor and checks client buffers, so it is replay convergence, not a cosmetic ping. |

Other backend recurrence is event-scheduled lifecycle work rather than a
standing timer: native projection hydration and display-tail debounce (B23),
merge cleanup (B25). OpenCode agent-tool re-verification on a 5 min connected
TTL (B24) went with OpenCode 1.x on 2026-11-11: each OpenCode 2 session
registers its own Orkestrator MCP servers.

**Per-pass skips.** Several passes skip work an earlier read already answers;
each skip gives the same answer the skipped read would have:

- Mail presence (B10, `refreshPresenceOnce`) reads each environment once per
  pass and records a stopped one's presence without a per-mailbox read:
  native `environment_stopped` when the environment is missing, being
  deleted or not running, tmux `environment_unready` when it is not ready
  for agents. Tmux presence accepts the session's last `has-session` answer
  if it is under 3 s old (`livenessMaxAgeMs`); a dispatch still probes.
- The human-prompt monitor (`AgentHumanPromptMonitor`) reuses a working
  session's last bridge observation for at most 30 s while
  `NativeAgentService.humanPromptContentRevision` is unchanged. Background
  task files are read every pass, because a background task's sign-in prompt
  appears only there. Providers with no content revision (OpenCode, Cursor,
  Pi, Grok) are read every pass.
- The build pipeline's review fan-out builds the shared package prompt
  (review instruction plus project notes) once per pass.
- The container Claude login keeper skips the marker `docker exec` when a
  matching keeper handover (same pinned account and generation) already
  pushed the same digest; delivery still re-reads its fences after host I/O.
- The public operation reconciler (B31) skips a run whose last observation
  found its turn ended with a later turn in the session: the journal only
  grows and an ended observation is kept while later turns run, so the
  observation cannot change until the run's record changes or its
  environment goes. A full pass every 10 min, a pass for the environment's
  change and a client read still observe it.
- The PR monitor polls a quiet open PR every 2 min instead of 20 s (B01)
  only when its reading has not moved for 15 min, its last rollup succeeded
  with nothing pending, its mergeability is known and neither Orkestrator's
  nor GitHub's auto-merge is on: a finishing check may not change
  `updatedAt`. Any wake or changed reading returns it to 20 s at once.

### Renderer

None of these is recorded; the IDs are the only names.

| ID | Source | Cadence |
| --- | --- | --- |
| C01 | `useNativeAgentSession.ts`, `native-session-read-policy.ts` | Active tab: 500 ms while running, blocked, cancelling or recovering; 1.5 s idle. A qualified provider's quiet idle view backs off through 3, 5, 10 and 15 s (`NATIVE_QUIET_BACKOFF_TRIAL_MS`); qualified today: Cursor, Pi, Grok and OpenCode, plus Claude and Codex while the session is `turn.quietObservation`, and only when the backend advertises observation events. Any invalidation returns it to 1.5 s. Several views of one session share one coordinated read. With data saving on, the responsive cadence is 1 s. A round over tokens the view holds is one request for transcript and state (`get_native_agent_live_update`, when the backend advertises it). Discovery is not in the round: it is read on mount, a session or identity change, an explicit read, a resync, a resume or reconnect, a phase change and an invalidation that names discovery, while a section has not settled, and otherwise every 30 s (`NativeDiscoveryReadSchedule`). |
| C02 | `useFilesPanel.ts` | 5 s while the panel is open and the environment available; immediate on open, tab, target, action or announced revision. With data saving on, backs off through 10, 15 and 30 s on a watched worktree (10 s otherwise). |
| C03 | `resource-sync.ts` | Resource events coalesce for 50 ms; revision gaps and reconnects trigger a manifest check; 5 min safety manifest check. |
| C05 | `MultiReviewReviewerTab.tsx` | 4 s while active and running or pending; conditional on a source token; immediate on a workflow checkpoint. With data saving on, backs off through 8, 15 and 30 s. |
| C06 | `ReviewValidationStatus.tsx` | 2 s, completion-scheduled, while the output modal is open and the result queued or running; byte-offset reads. |
| C07 | `InitializationLogs.tsx` | 1 s while mounted; the backend shares the Docker log tail across clients. |
| C08 | `SystemUsageIndicator.tsx`, `AgentInfoButton.tsx` | One shared read key: title bar 5 s, process and agent popovers 3 s while open. A read fails after 20 s; its request cannot be aborted, so that key sends no other until it settles (`useSystemUsage.ts`). A failed read with no earlier sample, or a backend without the command (`unsupported`, which stops polling), shows "Couldn't read processes" and "Data unavailable" on the tiles; a failed read keeps polling and recovers by itself. |
| C09 | `App.tsx` | Startup, explicit retry and every 60 s (`startCoordinatedPoll`). |
| C10 | `ServerConnectionSwitcher.tsx` | Active connection every 30 s and on focus; inactive entries on demand with a 10 s cache; young in-flight probes are joined, probes older than 5 s superseded. |
| C11 | `useCoordinatorPanelData.ts` | Event-led from scoped `coordinator` resource changes with conditional reads; a 60 s repository-status probe (the full 60 s poll only for older backends); focus probes at least 10 s apart. |
| C12 | `design-controller.ts` | Events plus a 3 s cursor check. |
| C14 | `CursorSdkSignIn.tsx` | 1.5 s only while a login is pending; one read in flight. |

C05 to C14 are scheduled through the read coordinator, so they pause while
hidden and reconcile on return. So do the polls of open dialogs and panels
(Docker settings, rebuild, recovery copies, project copy, machine maintenance,
bug report draft, GitHub CLI login), through `startCoordinatedPoll`
(`lib/coordinated-poll.ts`), the replacement for a bare `setInterval` around a
read. Presentation clocks (`useElapsedTimer`, `usePromptDeadline`, usually 1 s)
are not recurring work in this sense; the server's approval expiry stays
authoritative. Web-annotation capture polls status through the same helper while
a selection is in progress (`SELECTION_POLL_MS` in `useAnnotationCapture.ts`);
see [web-page-annotations.md](web-page-annotations.md).
Transport timers (gateway reconnect, terminal socket acknowledgement and
batching) are recovery work covered by
[event-snapshot-recovery.md](event-snapshot-recovery.md).

### Bridges, desktop and bounded waits

Apart from L01 (`gateway-heartbeat`, in the backend table), none of these is
recorded.

| ID | Source | Cadence |
| --- | --- | --- |
| L02 | `bridges/codex-bridge/src/index.ts`, `bridges/claude-bridge/src/routes/events.ts` | Every 30 s per connection; Codex echoes the latest revision. |
| L03, L04 | Codex app-server lifecycle and bridge index; Claude `session-manager-persistence.ts` and `session-manager-runtime-idle.ts` | Codex idle-session and index cleanup every 5 min; Claude evicts idle hydrated transcripts every 5 min. Each warm Claude CLI has one deadline, armed when a turn hands back the foreground and restarted by its own frames: it closes input after 10 min of silence (`CLAUDE_BRIDGE_RUNTIME_IDLE_MS`; at least 5 min while a continuation is owed) and re-checks a CLI still running tasks every 10 min. |
| L05 | Cursor and Pi `server.ts`, `BridgeLifecycle` (`packages/protocol/src/bridge-lifecycle.ts`) | 1 min idle sweep, 10 min idle detach; parent check every 1 s (`PARENT_WATCH_INTERVAL_MS`). `BridgeLifecycle` owns the handles, clears every timer on shutdown and rejects a repeated start. |
| L06 | `packages/protocol/src/parent-watchdog.ts` | Every 1 s (`PARENT_WATCH_INTERVAL_MS`), used by every bridge; ACP can override it with `ACP_PARENT_WATCHDOG_INTERVAL_MS`. A restarted backend reaps orphans 5 to 7 s after it starts, so detection must come well inside that. On detection the Codex bridge interrupts running turns (2 s budget) before it drains. |
| L07 | `bridges/acp-bridge/src/acp-client-disconnect.ts` | Event-only. ACP no longer polls sockets; request `aborted`, response `close` and socket `end`/`close` cover every tested disconnect shape. |
| L08 | `packages/protocol/src/node/bridge-diagnostics.ts` | One 60 s timer per open scope (written every tick at debug; otherwise on a stall transition, late tick, a change during a silent stall, or the 10 min keepalive; `change` snapshots at trace use no timer) and the buffered logger's 60 s flush. |
| L09 | `packages/protocol/src/node/application-logging.ts` | Startup plus every 6 h. |
| L10 | `packages/toolchain/src/manager.ts`, Claude `session-preferences.ts` | Lock heartbeat while an operation is owned. |
| L11 | `scripts/test-admission.ts`, `host-test-scheduler.ts` | Test-only: 500 ms channel heartbeat, 100 ms admission polling. Not desktop idle cost. |
| L12 | `apps/ios/OrkestratorMobile/Views/RemoteWebView.swift` | At most 100 readiness checks 100 ms apart after navigation; two successes required. |
| L13, L14 | Server health, desktop backend startup, tmux and Docker setup; PTY, terminal history and Codex coalescers | Operation-scoped readiness waits with finite deadlines, and data-triggered flush and debounce with bounded buffers and shutdown flush. |

## Latency budgets

A cadence may change only while its budget still holds, and the change
records measured p50/p95 against it. Exceeding a budget must be accepted
explicitly; terminal PR discovery is the one accepted slowdown. These are
targets for a live profile; the deterministic harness does not measure them.

| Freshness | Nominal today | Budget (p95) | Notes |
| --- | --- | --- | --- |
| Pending approval or question visible, active view | 500 ms refresh (C01) | ≤ 2 s | Approval timeout still denies; never relaxed |
| Background environment activity indicator | 2 s sweep (B06), 4 s idle safety read | ≤ 4 s | |
| Turn completion visible, queued prompt dispatched | Turn-end edge plus 2 s sweep (B06, B07) | ≤ 3 s | The edge path should dominate |
| Mail presence | 2 s refresh, 4 s TTL (B10) | ≤ 4 s | Never inject into an active session |
| Diff badge, watched local worktree | 400 ms settle plus scan, and at least 2 s from one scan's end to the next hinted one (`LOCAL_SCAN_MIN_GAP_MS`, B03) | ≤ 2 s after the save settles | A missed hint is recovered by the 120 s safety scan. Saves less than 2 s apart wait out the gap; back-to-back saves measured 1.6 to 1.7 s after settling in the packaged macOS app (todo 0048, task 7) |
| Diff badge, container or unwatched | 15 s poll (B03) | ≤ 20 s | |
| Files panel list and tree, panel open | 5 s client poll; 3 s list reuse (B04, C02) | ≤ 6 s; ≤ 1 s after an explicit action, or one scan longer when a scan is already running | Explicit refresh waits for a read started after the click, so a Changes refresh that lands while a scan runs waits for that scan and then a fresh one. Accepted 2026-11-10 (todo 7201): a container Changes refresh measured p50 425 to 543 ms and p95 1.30 s and 2.23 s over two runs of 15 on macOS; All files stayed ≤ 1 s (max 881 ms) |
| PR merge confirmation after merge-pending | 1 s (B01) | ≤ 3 s | |
| PR created after create-pending | 5 s (B01) | ≤ 10 s | |
| Open PR state change | 20 s (B01) | ≤ 30 s | Includes jitter |
| Terminal PR replacement or reopen | 5 min plus jitter (B01) | ≤ 5 min plus immediate explicit and completion wakes | Accepted slowdown |
| Workflow progress after a result | Keyed wake; 1 to 1.5 s passes (B14 to B17); 250 ms passes while an accepted Multi Review result or graph node output waits for its turn to end | ≤ 3 s | Before 2026-11-10 about one Multi Review in four waited one observation pass after its consolidated result (3.7 to 4.3 s, todo 7557); graph runs had the same order until 2026-11-11 (todo 7564) |
| Lease renewal, approval and auth expiry, watchdogs | 5 s renewal of a 15 s lease (B16); durable deadlines | Unchanged | Critical class |
| Recovery after a deliberately missed hint | Safety scans and discovery passes | Unchanged or better | Required before reducing any polling |

With data saving on, the client accepts slower backstops for what it shows
([remote-bandwidth.md](../development/remote-bandwidth.md)): approval and question visibility (≤ 2 s) and turn completion
(≤ 3 s) keep their budgets, because both arrive through observation
invalidations that read at once and the responsive backstop is 1 s. The Files
panel accepts ≤ 2 s after an announced revision on a watched worktree and
≤ 11 s on an unwatched target (its 10 s backstop); an explicit action stays
≤ 1 s, or one scan longer behind a running scan. A reviewer tab follows checkpoints at once with a ≤ 30 s backstop.
These budgets apply only to the client that turned the preference on.

The container file-list reuse bound stays at 3 s for this reason: with a 5 s
panel poll, any bound of 5 s or more would serve every other read from the
previous poll and let a change take about 10 s to appear, over the 6 s
budget. A quiet open container panel therefore still costs one status exec
per read.

## Rules for changing recurring work

- Events give prompt reaction; authoritative snapshots reconcile. Reducing a
  safety interval needs explicit missed-event recovery evidence.
- Prefer joining equivalent reads over caching results longer. Keys include
  connection and generation, target, identity, options and revision;
  credential-sensitive scopes never share results.
- Observation stays separate from attach, hydrate, dispatch and touch.
  Background observers never keep idle threads resident or start bridges.
- Leases, approval and authentication deadlines and watchdogs stay in the
  critical class, outside optional-work queues.
- Older backends and bridges keep working through capability negotiation and
  conservative fallback; a network or auth error is not proof a capability is
  missing.
- Measurement must not add the load it measures: never shadow `gh`, Git or
  provider reads at production scale, or any workflow mutation or prompt
  dispatch.
- No distributed queue, mandatory webhook server, extra database or single
  scheduler spanning backend, bridges and browser. Use small scheduling
  primitives inside each owning process.
- Update the `RECURRING_JOB_CATALOGUE` entry in the same change, and run the
  deterministic harness (see
  [testing-guide.md](../development/testing-guide.md#recurring-work-harness))
  to show which counters moved.

### B26 — Node summary reconciliation

`NodeReadModel` owns the named `node-summary-reconcile` activity due job (60 s). It rereads connected node summaries as a safety pass for missed events, joins each node’s hydrate with one trailing rerun, and stops with the portal. Scheduler diagnostics expose its deadline; recurring-work metrics are not yet recorded for this kind. Unit tests can override `reconcileMs`.
