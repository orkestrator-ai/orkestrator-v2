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
[recurring-work-qualification.md](../todo/recurring-work-qualification.md).

## Vocabulary and diagnostics

`packages/protocol/src/recurring-work.ts` is the shared, dependency-free
vocabulary:

- `RECURRING_JOB_KINDS` names every job. A kind is the only label a
  recurring-work metric may carry; an environment id, path, branch, URL,
  prompt or command output can never become a dimension.
- `RECURRING_JOB_CATALOGUE` records, per kind, the owning process, trigger,
  priority class, nominal cadence, in-flight policy, recovery contract and
  whether it is instrumented. Its `inventory` field holds the IDs used in the
  tables below (B for backend, C for renderer, L for bridges, desktop and
  bounded waits; `F02` marks the container fetch policy). The catalogue is
  descriptive: nothing reads a cadence from it to drive a timer, and a
  cadence or policy change updates its entry in the same change.
- `RECURRING_WORK_UNITS` counts physical work (`git-spawn`, `gh-spawn`,
  `docker-exec`, `directory-read`, `provider-request`, `storage-read`,
  `record-scanned`, …) at the boundary that performs it, attributed to the
  innermost recurring job. `storage-read` counts stored content decoded for a
  caller, whether the database or its revision-validated row cache served it;
  `storage-stat` counts a revision or stat check that reused values already
  decoded (see [storage.md](storage.md)).

The backend recorder, `recurringWorkMetrics`
(`apps/backend/src/core/recurring-work-metrics.ts`), keeps one fixed record
per kind (requested, coalesced, started, completed, failed, rejected,
changed/unchanged, cache hits, bytes, duration and queue-delay histograms,
work units, error categories) and tracks at most
`RECURRING_WORK_MAX_TRACKED_ACTIVE` (1,024) in-flight attempts. Errors are
recorded as finite categories, never messages. `ORKESTRATOR_RECURRING_METRICS=0`
turns it off. Renderer, bridge and desktop kinds are catalogued but not
recorded (`instrumented: false`).

`recurringWorkDiagnostics()` (`recurring-diagnostics.ts`) is the one
read-only surface: recorder snapshot, every live scheduler, admission pool
and fetch policy, all aggregate and content-free. It is served by the
`get_recurring_work_diagnostics` command and the `recurringWork` block of the
gateway's `/__orkestrator/metrics`.

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
build pipelines, looped review, multi review and native prompt queues keep one
due key per record that owes work, instead of listing the whole store each
tick. Wakeups come from workflow-result acceptance, environment readiness and
identity changes, provider transitions, enqueue and turn end, queue
mutations, deletions and explicit commands; a 30 s discovery pass
(`DEFAULT_WORKFLOW_DISCOVERY_MS`) is the safety net. An incomplete discovery
adds what it found but never drops a key. Obligations are named per domain,
not inferred from a `running` phase.

**Native observation broker** (`native-agent-observation.ts`). The backend's
activity sweep is the only observer of provider activity. Prompt-queue
drains, agent mail, the coordinator and workflows read its bounded,
content-free observation instead of issuing their own provider reads.
Observation uses the no-touch `/activity` route; it never starts a bridge,
attaches, hydrates or refreshes liveness. Dispatch and generation fences make
a pre-dispatch idle inert. A provider group whose sessions are all stably
idle backs off to a 4 s safety read (`STABLE_IDLE_BACKOFF_MS`) only when the
provider has a qualified wakeup for work started elsewhere. See
[event-snapshot-recovery.md](event-snapshot-recovery.md) for the stamped
session-activity announcements.

**Client read coordinator** (`apps/web/src/lib/read-coordinator.ts`, used via
`useCoordinatedRead`) owns renderer presentation reads: one timer per read
key with the fastest active demand winning, joining of equivalent in-flight
reads, a single trailing read per invalidation burst, and `refresh()` that
always waits for a read started after the call. Automatic reads pause while
the document is hidden or a transport has declared itself disconnected, and
visibility, focus, page-show, online and reconnect signals are coalesced for
50 ms and reconciled once, critical keys first. Failed reads back off and keep
the last good value as stale. The coordinator never owns prompt submission,
approval resolution, workflow progress or queue draining.

### Rollback switches

Each is read once at startup and allowed through the desktop environment
allowlist in `apps/desktop/electron/backend-process.ts`:

- `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` (`workflow-supervisor.ts`): a comma
  list of `feature-planning`, `build-pipeline`, `looped-review`,
  `multi-review`, `native-queues`, `backend-activity`, or `all`. A named domain
  runs its old whole-store driver; `multi-review` falls back to
  `WorkflowDueScheduler`.
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
| B03 | `diff-scan` | `diff-stats-service.ts`, `worktree-watcher.ts` | Watched local worktree: hints settle for 400 ms, plus a 120 s safety scan. Container or unwatched: 15 s poll. A periodic tick is skipped if any scan started within half an interval. Failures back off 5 s to 60 s; a failed watcher retries 30 s to 10 min and falls back to polling. |
| B03 | `change-capture` | `change-tracking/worktree-owner.ts`, `turn-boundaries.ts` | Not periodic. Turn start/end and restore captures run through the shared `git-docker-scan` pool at `interactive` priority, at most one per worktree, two remote at a time; provisional captures of a running turn follow watcher hints at most every 1 s locally / 5 s remotely. Boundary deadline 10 s, finalization 30 s. See [change-tracking.md](change-tracking.md). |
| B06 | `change-evidence-pull` | `change-tracking/service.ts` | Rides the 2 s activity sweep: after a bridge connection is observed, its change-evidence spool is pulled (single flight per connection; a bridge without the route is rechecked after 5 min). |
| B03 | `change-retention` | `change-tracking/retention.ts` | Hourly: reference expiry, quota transitions and the object-store sweep with an orphan grace window. |
| B04 | `file-list-read`, `file-tree-read` | `DiffStatsService.readFileList` / `readTree` | Read-driven; joins the owner's scan. Watched worktrees answer from watched state until a hint. Unwatched file lists are reused for up to 3 s (`FILE_LIST_MAX_AGE_MS`). Container trees are reused for up to 10 s while a recent complete file list covers them, and re-walked at once when list membership changes. Revisions are described in [event-snapshot-recovery.md](event-snapshot-recovery.md). |
| B05 | `git-fetch-local` | `git-fetch-scheduler.ts` | Read-driven 5 min TTL per common Git directory and ref; concurrent fetches join; failures also stamp the cooldown. |
| F02 | `git-fetch-container` | `container-git-fetch.ts` | Separate from the status scan, which reads local refs only. 5 min attempt cooldown per container generation, clone and ref; failures back off 5, 10, 20 then 30 min; explicit refreshes at least 15 s apart; immutable local baselines never fetch; a missing ref gets one recovery fetch per window. A fetch that moves `origin/<ref>` triggers a rescan. |
| B06 | `native-activity-sweep` | `core/index.ts`, `native-agent-service-reconciliation.ts` | Every 2 s, fixed rate; due provider groups only (see the observation broker). Eight workers, retry backoff, no-touch reads. |
| B07 | `native-launch-scan`, `native-queue-scan` | `native-agent-queue-scheduling.ts` | Keyed: 2 s while a launch intent or queued dispatch is pending (drain backoff 2 s to 60 s honoured), else a 30 s safety pass; enqueue, turn end and environment changes wake it. |
| B08 | `native-interaction-observe` | `native-agent-service-base.ts` | Every 2 s, only when the interaction monitor is `observe-only`. |
| B09 | `claude-state-reconcile`, `tmux-queue-drain`, `pending-rename-reconcile` | `core/index.ts` (`BackendActivityJobs`) | Each its own named job at 2 s fixed rate, never overlapping. Pending renames drop to a 30 s safety pass when none are pending. |
| B10 | `mail-presence`, `mail-injection` | `agent-mail-service.ts` | Resource changes coalesce for 250 ms; 2 s safety jobs. Observed presence lives 4 s, so the 2 s refresh must not be slowed on its own. |
| B11 | `coordinator-repair`, `mail-retention` | `core/index.ts` | Own elapsed 60 s deadlines. Retention prunes mail older than `agentMessaging.retentionDays` (default 14). |
| B12 | `activity-lease-expiry` | `core/index.ts`, `protocol/agent-activity.ts` | Every 15 s for a 30 s frontend activity lease. Critical. |
| B13 | `tab-cleanup` | `core/index.ts` | 60 s plus startup; teardown and orphan reaping each guarded in flight; orphans get a one-hour grace. |
| B14 | `build-supervisor-tick` | `build-pipeline-service-lifecycle.ts` | Keyed: one pass per pipeline with an obligation every 1.5 s, 30 s discovery. A pass looks at a session's transcript only at the 5 s persist boundary, when a turn ends or while a stall warning shows, through a conditional progress probe; the whole body is read only when the probe moved since the committed copy, and always once when a turn ends (`refreshMovedTranscript`). |
| B15, B16 | `looped-review-tick`, `multi-review-tick`, `*-lease-renewal` | `looped-review-service.ts`, `multi-review-service.ts` | Keyed per-workflow 1 s passes, 30 s discovery. Controller lease 15 s, renewed every 5 s (critical). Multi review keeps `adaptiveScheduling: false` as a legacy 1 s tick. |
| B17 | `feature-planning-tick` | `feature-planning.ts` | Keyed per-record 1 s passes, 30 s discovery. |
| B18 | `tmux-poll` | `tmux-poll.ts` | One `docker exec` per read, change-only writes. On `claude-state-signal` images the hooks ring the backend, which reads on each ring plus a 30 s safety read (2 reads a minute idle); a change the safety read finds unannounced returns the container to 1 s. Older images, and containers whose doorbell has not rung, keep the 1 s poll, which dominates their idle cost. See [container-lifecycle.md](container-lifecycle.md#claude-terminal-state-signal-claude-state-signal1). |
| B19 | `tmux-interactive-capture` | `tmux-interactive.ts` | Completion-scheduled 250 ms, doubling to 1 s while output is unchanged, per attached interactive terminal. Bounded line patches; exact screen recovery. |
| B20 | `validation-heartbeat` | `review-validation-worker.ts` | 500 ms persistence and cancel heartbeat; 100 ms cooperative clock. Cross-process liveness, so partly correctness-related. |
| B21 | `storage-lock-heartbeat` | `storage-base.ts`, `storage-database.ts` | Lease holders heartbeat at least every third of the stale threshold. Critical. |
| B22 | `opencode-reconnect` | `opencode-observation-stream.ts` | Event stream; reconnect backs off from 1 s to 30 s and resets after a healthy stream. Gaps are marked and reconciled. |
| C08 | `system-usage-sample`, `process-usage` | `commands-registry-system.ts` | Demand-driven by clients; concurrent reads join. |
| L01 | `gateway-heartbeat` | `gateway-handlers.ts` | Shared 25 s keepalive. It also advances the scoped stream cursor and checks client buffers, so it is replay convergence, not a cosmetic ping. |

Other backend recurrence is event-scheduled lifecycle work rather than a
standing timer: native projection hydration and display-tail debounce (B23),
OpenCode agent-tool re-verification on a 5 min connected TTL (B24) and merge
cleanup (B25).

### Renderer

| ID | Kind | Source | Cadence |
| --- | --- | --- | --- |
| C01 | `client-native-session-refresh` | `useNativeAgentSession.ts`, `native-session-read-policy.ts` | Active tab: 500 ms while running, blocked, cancelling or recovering; 1.5 s idle. A qualified provider's quiet idle view backs off through 3, 5, 10 and 15 s (`NATIVE_QUIET_BACKOFF_TRIAL_MS`); qualified today: Cursor, Pi, Grok and OpenCode, and only when the backend advertises observation events. Any invalidation returns it to 1.5 s. |
| C02 | `client-files-panel` | `useFilesPanel.ts` | 5 s while the panel is open and the environment available; immediate on open, tab, target or action. |
| C03 | `client-resource-manifest` | `resource-sync.ts` | Resource events coalesce for 50 ms; revision gaps and reconnects trigger a manifest check; 5 min safety manifest check. |
| C05 | `client-reviewer-transcript` | `MultiReviewReviewerTab.tsx` | 4 s while active and running or pending; conditional on a source token. |
| C06 | `client-validation-output` | `ReviewValidationStatus.tsx` | 2 s, completion-scheduled, while the output modal is open and the result queued or running; byte-offset reads. |
| C07 | `client-init-logs` | `InitializationLogs.tsx` | 1 s while mounted; the backend shares the Docker log tail across clients. |
| C08 | `client-system-meters` | `SystemUsageIndicator.tsx`, `AgentInfoButton.tsx` | One shared read key: title bar 5 s, process and agent popovers 3 s while open. |
| C09 | `client-docker-availability` | `App.tsx` | Startup, explicit retry and every 60 s. |
| C10 | `client-connection-health` | `ServerConnectionSwitcher.tsx` | Active connection every 30 s and on focus; inactive entries on demand with a 10 s cache; young in-flight probes are joined, probes older than 5 s superseded. |
| C11 | `client-coordinator-panel` | `useCoordinatorPanelData.ts` | Event-led from scoped `coordinator` resource changes with conditional reads; a 60 s repository-status probe (the full 60 s poll only for older backends); focus probes at least 10 s apart. |
| C12 | `client-design-canvas` | `design-controller.ts` | Events plus a 3 s cursor check. |
| C14 | `client-cursor-login` | `CursorSdkSignIn.tsx` | 1.5 s only while a login is pending; one read in flight. |

C05 to C14 are scheduled through the read coordinator, so they pause while
hidden and reconcile on return. Presentation clocks (`useElapsedTimer`,
`usePromptDeadline`, usually 1 s) are not recurring work in this sense; the
server's approval expiry stays authoritative. Web-annotation capture polls
status while a selection is in progress (`SELECTION_POLL_MS` in
`useAnnotationCapture.ts`); see [web-page-annotations.md](web-page-annotations.md).
Transport timers (gateway reconnect, terminal socket acknowledgement and
batching) are recovery work covered by
[event-snapshot-recovery.md](event-snapshot-recovery.md).

### Bridges, desktop and bounded waits

| ID | Kind | Source | Cadence |
| --- | --- | --- | --- |
| L02 | `bridge-sse-keepalive` | `bridges/codex-bridge/src/index.ts`, `bridges/claude-bridge/src/routes/events.ts` | Codex checks every 5 s and sends at 5 s while active, 30 s while idle, echoing the latest revision; Claude every 30 s per connection. |
| L03, L04 | `bridge-idle-sweep` | Codex app-server lifecycle and bridge index; Claude `session-manager-persistence.ts` and `session-manager-runtime-idle.ts` | Codex idle-session and index cleanup every 5 min; Claude evicts idle hydrated transcripts every 5 min. Each warm Claude CLI has one deadline, armed when a turn hands back the foreground and restarted by its own frames: it closes input after 10 min of silence (`CLAUDE_BRIDGE_RUNTIME_IDLE_MS`; at least 5 min while a continuation is owed) and re-checks a CLI still running tasks every 10 min. |
| L05 | `bridge-idle-sweep`, `bridge-parent-watchdog` | Cursor and Pi `server.ts`, `BridgeLifecycle` (`packages/protocol/src/bridge-lifecycle.ts`) | 1 min idle sweep, 10 min idle detach; parent check every 5 s. `BridgeLifecycle` owns the handles, clears every timer on shutdown and rejects a repeated start. |
| L06 | `bridge-parent-watchdog` | `packages/protocol/src/parent-watchdog.ts` | Default 15 s; callers override with their required detection time. |
| L07 | — | `bridges/acp-bridge/src/acp-client-disconnect.ts` | Event-only. ACP no longer polls sockets; request `aborted`, response `close` and socket `end`/`close` cover every tested disconnect shape. |
| L08 | `bridge-diagnostics-heartbeat` | `packages/protocol/src/node/bridge-diagnostics.ts` | 60 s heartbeat and usage flush. |
| L09 | `desktop-log-retention` | `packages/protocol/src/node/application-logging.ts` | Startup plus every 6 h. |
| L10 | — | `packages/toolchain/src/manager.ts`, Claude `session-preferences.ts` | Lock heartbeat while an operation is owned. |
| L11 | — | `scripts/test-admission.ts`, `host-test-scheduler.ts` | Test-only: 500 ms channel heartbeat, 100 ms admission polling. Not desktop idle cost. |
| L12 | — | `apps/ios/OrkestratorMobile/Views/RemoteWebView.swift` | At most 100 readiness checks 100 ms apart after navigation; two successes required. |
| L13, L14 | — | Server health, desktop backend startup, tmux and Docker setup; PTY, terminal history and Codex coalescers | Operation-scoped readiness waits with finite deadlines, and data-triggered flush and debounce with bounded buffers and shutdown flush. |

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
| Diff badge, watched local worktree | 400 ms settle plus scan (B03) | ≤ 2 s after the save settles | A missed hint is recovered by the 120 s safety scan |
| Diff badge, container or unwatched | 15 s poll (B03) | ≤ 20 s | |
| Files panel list and tree, panel open | 5 s client poll; 3 s list reuse (B04, C02) | ≤ 6 s; ≤ 1 s after an explicit action | Explicit refresh waits for a read started after the click |
| PR merge confirmation after merge-pending | 1 s (B01) | ≤ 3 s | |
| PR created after create-pending | 5 s (B01) | ≤ 10 s | |
| Open PR state change | 20 s (B01) | ≤ 30 s | Includes jitter |
| Terminal PR replacement or reopen | 5 min plus jitter (B01) | ≤ 5 min plus immediate explicit and completion wakes | Accepted slowdown |
| Workflow progress after a result | Keyed wake; 1 to 1.5 s passes (B14 to B17) | ≤ 3 s | |
| Lease renewal, approval and auth expiry, watchdogs | 5 s renewal of a 15 s lease (B15, B16); durable deadlines | Unchanged | Critical class |
| Recovery after a deliberately missed hint | Safety scans and discovery passes | Unchanged or better | Required before reducing any polling |

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
