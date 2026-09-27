# Recurring processes: investigation and recommendations

Status: Investigation complete; implemented. See the
[plan index](../improvements/recurring-processes/plan/00-index.md) and step 12's
qualification notes. Claude terminal-state polling (B18) was measured but left
unchanged, and it now dominates the remaining container idle cost.

Date: 2026-09-21. Source baseline: `88c2f9ccfaa68045573b658dd4f172bc5ff7c51b`.

Implementation plan: [index and numbered steps](../improvements/recurring-processes/plan/00-index.md).
The spelling of this report's `imrovements` directory follows the requested path.

## Summary

The largest opportunities are reducing repeated work at its source and sharing
authoritative reads across consumers. Simply increasing all intervals would
delay approvals, workflow progress, queued prompts, and recovery without fixing
the duplication.

Several substantial improvements already exist: PR monitoring and diff statistics
are backend-owned; local worktrees have watchers; local Git fetches share a
five-minute cache across worktrees; resource synchronization uses revisions and
scoped snapshots; native-agent reads support conditional and progressive views;
activity reconciliation has an eight-worker concurrency limit; several pollers
already collapse overlapping requests. Preserve and extend these mechanisms.

Highest-value changes, in recommended order:

1. Give file changes, diff counts, and file-tree readers shared backend read
   ownership, with independent revisions for each view. The Files panel's
   five-second polling currently often outlives its three-second shared cache.
2. Separate container Git fetch freshness from local diff scans. The container
   status script currently attempts a fetch on every scan.
3. Make PR cadence reflect lifecycle, and bound aggregate GitHub work. Terminal
   PRs still trigger normal-cadence branch discovery while their environments
   remain eligible. Preserve reopening, replacement PR discovery, and unfinished
   reconciliation when reducing this traffic.
4. Coordinate renderer reads by resource and visibility. Native-session views
   schedule every 500 ms while active and 1,500 ms while idle, even though
   resource invalidations and smaller conditional surfaces also exist.
5. Replace frequent broad workflow/queue scans with keyed wakeups and due work,
   retaining startup and periodic reconciliation from durable records.
6. Standardize concurrency, backoff, lifecycle cleanup, and content-free
   measurements. Keep lease renewal and safety deadlines outside optional-work
   queues.

## Scope and method

This is a static source investigation, not a runtime performance measurement.
No application code, dependencies, live application data, or external resources
were changed. No production process was started or observed.

Searches covered `apps/`, `bridges/`, `packages/`, `scripts/`, `docker/`, and
workflow configuration, including interval timers, recursively scheduled
timeouts, asynchronous retry loops, filesystem watchers, heartbeat/lease logic,
and native iOS readiness waits. The initial broad search returned 323 matching
timer/loop sites; this is a search result count, **not** a count of independent
recurring processes. It included test helpers, stream readers, one-shot
deadlines, UI effects, and debounce callbacks.

The inventory below groups production recurrence by owner and purpose. Source
links name current implementations; function names locate the relevant code
without relying on line numbers that will move during implementation. Internal
vendor/SDK scheduling and operating-system/browser internals were not audited.
Static source alone cannot establish their CPU, battery, or network cost.

No external API redesign is required by these findings. Before implementing any
library- or service-specific mechanism, fetch current documentation through the
repository's Context7 workflow. Proposed intervals and limits below are trial
values requiring measurement, not claims about externally guaranteed behavior.

## Inventory: backend work and authoritative state

| ID | Owner and source | Trigger / cadence | Scope, current protections, recommendation |
| --- | --- | --- | --- |
| B01 | [PR monitor](../../apps/backend/src/core/pr-monitor.ts), [wire policy](../../packages/protocol/src/pr-monitor.ts) | Completion-scheduled: normal 20 s; create pending 5 s; merge pending 1 s. Pending limits 10 min / 20 s. Errors back off to 5 min. | One entry per environment with a known PR or pending intent; idle-edge probes discover unknown PRs. Per-entry serialization and generation fences exist. Add aggregate limits, jitter, and terminal discovery policy. |
| B02 | [PR detection](../../apps/backend/src/core/commands-pr-monitor.ts) | Within B01; check rollup attempted at most once per 60 s per entry; skipped in merge-pending. | Known nonterminal PR uses identity lookup; unknown/terminal state resolves branch then discovers PR. Keep check permission failures separate from lifecycle detection. |
| B03 | [Diff statistics](../../apps/backend/src/core/diff-stats-service.ts), [watcher](../../apps/backend/src/core/worktree-watcher.ts) | Local watcher coalesces changes for 400 ms plus 120 s safety scan; container or failed watcher scans every 15 s. | Per-environment timer and in-flight/rescan guard; shared by clients. No service-wide scan limit or error backoff. Watcher failure falls back to polling. |
| B04 | [File commands](../../apps/backend/src/core/commands-registry-terminal.ts), [cache wiring](../../apps/backend/src/core/commands-runtime-state.ts) | Read-driven; Files panel usually every 5 s. | Three-second diff file-list cache; miss runs a separate scan and adopts its list. Conditional digest reduces response bytes after computation. Tree reads also compute before comparison. Unify concurrent reads with B03. |
| B05 | [Local Git fetch scheduler](../../apps/backend/src/core/git-fetch-scheduler.ts) | Read-driven five-minute TTL, explicit invalidation. | Shares by common Git directory + ref and joins concurrent fetches. Failed fetch attempts also stamp the cooldown. Retain; expose freshness separately and extend equivalent policy to containers. |
| B06 | [Native activity sweep](../../apps/backend/src/core/index.ts), [reconciliation](../../apps/backend/src/core/native-agent-service-reconciliation.ts) | Every 2 s. | Enumerates environments/sessions, groups by provider/environment; scan single-flight, eight workers, retry backoff, no-touch activity reads. Still revisits the broad registered set. Introduce due groups and share observations. |
| B07 | [Launch and native prompt queues](../../apps/backend/src/core/native-agent-service-base.ts), [reconciliation](../../apps/backend/src/core/native-agent-service-reconciliation.ts) | Every 2 s plus immediate actions/turn-end drains. | Scans environments and all queues; per-target retry state and durable dispatch guards. Add keyed pending indexes and scoped wakeups; keep restart recovery. |
| B08 | [Interaction observer](../../apps/backend/src/core/native-agent-service-base.ts) | Every 2 s when `interactionMonitorMode === "observe-only"`. | Conditional service, not an unconditional additional loop. Preserve provider policy and authoritative pending-interaction snapshots. |
| B09 | [Backend activity bundle](../../apps/backend/src/core/index.ts) | Same 2 s callback as B06. | Also reconciles Claude state polling, drains tmux queues, refreshes mail presence, drains mail injections, and reconciles pending renames. Sharing a timer does not share all underlying reads. Split explicit due policies while reusing observations. |
| B10 | [Mail service](../../apps/backend/src/core/agent-mail-service.ts) | Resource-driven 250 ms coalescing; B09 safety calls; observed presence TTL 4 s. | Existing event-driven delivery, coalesced drain/presence tasks, bounded injection batches. Changing the sweep alone would violate presence freshness assumptions. |
| B11 | [Coordinator recovery and mail retention](../../apps/backend/src/core/index.ts) | Every 30 activity ticks, nominally 60 s. | Workflow notification/delegation repair is guarded; retention loads config and prunes mail. Use elapsed deadlines instead of coupling to another timer's tick count; measure retention before slowing it. |
| B12 | [Frontend activity lease expiry](../../apps/backend/src/core/index.ts), [lease contract](../../packages/protocol/src/agent-activity.ts) | Every 15 s; lease duration 30 s. | Safety expiry, not view refresh. Keep separate from optional-work backoff. |
| B13 | [Tab cleanup](../../apps/backend/src/core/index.ts) | Every 60 s plus startup. | Teardown and orphan cleanup each have an in-flight guard; orphan grace is one hour. Already deliberately coarse. |
| B14 | [Build supervisor](../../apps/backend/src/core/build-pipeline-service-base.ts), [tick pass](../../apps/backend/src/core/build-pipeline-service-supervisor.ts) | Every 1.5 s plus explicit work. | Lists all pipeline records, validates/filter-selects active or terminal-reconciliation work; coalesces tick requests and locks pipelines. Use active indexes and bounded due jobs. |
| B15 | [Looped review](../../apps/backend/src/core/looped-review-service.ts) | Every 1 s; lease renewal every 5 s, lease 15 s. | Lists all workflows; caches validation by revision; skips inactive phases unless result settlement remains. Keep pending-result and cancellation obligations in any index. |
| B16 | [Multi review](../../apps/backend/src/core/multi-review-service.ts) | Every 1 s; lease renewal every 5 s, lease 15 s. | Lists and validates workflows; observes interactive Fix completion and retries durable handoffs too. Whole-service tick guard does not bound fan-out across different workflows. |
| B17 | [Feature planning](../../apps/backend/src/core/feature-planning.ts) | Every 1 s. | Uses `listActiveFeaturePlanning`, coalesced ticks, per-feature locking, reply/readiness deadlines. Closest existing model for narrowed work selection. |
| B18 | [Claude terminal state](../../apps/backend/src/core/tmux-poll.ts) | Every 1 s per tracked container. | Backend-owned, coalesced requests; change-only writes, throttled retirement checks, stale-read handling, transition-only PR probes. Measure exec/read cost before designing hook notifications. |
| B19 | [Interactive tmux capture](../../apps/backend/src/core/tmux-interactive.ts) | Completion-scheduled 250–1,000 ms per attached interactive terminal. | Doubles interval on unchanged output, sends bounded line patches, fences resize/detach. Possible demand gating; exact screen recovery is mandatory. |
| B20 | [Validation worker](../../apps/backend/src/core/review-validation-worker.ts) | 500 ms persistence/cancel heartbeat; 100 ms capacity/lock waits and cooperative execution clock. | Work-scoped, durable cross-process coordination. High frequency is partly correctness-related; separate liveness from unchanged result serialization before tuning. |
| B21 | [Storage locks](../../apps/backend/src/core/storage-base.ts), [workflow-result locks](../../apps/backend/src/core/workflow-result-service.ts) | Heartbeat while lock held; 25 ms acquisition retry paths. | Exclusion and stale-owner recovery. Keep independent of optional scheduling; review cancellation and bounds, not global interval stretching. |
| B22 | [OpenCode provider](../../apps/backend/src/core/opencode-provider.ts) | Event stream; reconnect loop defaults to 1 s after disconnect/failure. | Marks gaps and reconciles; not periodic full-data polling during a healthy stream. Consider capped jittered reconnect after sustained outage. |
| B23 | [Native projection](../../apps/backend/src/core/native-agent-service-projection.ts), [OpenCode lifecycle](../../apps/backend/src/core/opencode-session-lifecycle.ts) | Request/event-driven hydration, display-tail debounce, cached existence probes. | Smaller conditional surfaces, byte/message bounds, cache and concurrency controls already exist. Measure actual provider reads per renderer refresh before changing them. |
| B24 | [OpenCode agent tools](../../apps/backend/src/core/commands-servers.ts) | Configuration scheduling and five-minute connected TTL re-verification on relevant calls. | Not a standing five-minute timer. Preserve repair when the remote server loses MCP configuration. |
| B25 | [Merge cleanup](../../apps/backend/src/core/commands-servers.ts) | Event/recovery-scheduled lifecycle task with deadline helpers. | Preserve idempotent environment teardown and reconciliation completion; do not treat it as a simple repeating PR read. |

## Inventory: renderer and client reads

| ID | Source | Trigger / cadence | Assessment |
| --- | --- | --- | --- |
| C01 | [Native session hook](../../apps/web/src/hooks/useNativeAgentSession.ts) | Active tab: 500 ms running/blocked/cancelling/recovering, 1,500 ms idle; resource changes and resync also refresh. | No document-visibility gate in the interval effect. A refresh can fan into transcript/state/discovery commands; conditional responses are already supported. Highest client scheduling priority. |
| C02 | [Files panel](../../apps/web/src/hooks/useFilesPanel.ts) | Every 5 s while panel open and environment available; immediate open/tab/target/action refresh. | Per-hook in-flight guards and digest-based store suppression exist. No worktree-change subscription; no explicit hidden-document gate. |
| C03 | [Resource synchronization](../../apps/web/src/lib/resource-sync.ts), [store binding](../../apps/web/src/lib/store-resource-sync.ts) | 50 ms event coalescing; reconnect/revision gaps; five-minute manifest safety check. | Good convergence foundation: scoped cursor pages, conditional snapshots, batching and bounded concurrent delivery. Retain; avoid reinstating old broad snapshot polling. |
| C04 | [PR subscriber](../../apps/web/src/hooks/usePrMonitorService.ts), [diff subscriber](../../apps/web/src/hooks/useEnvironmentDiffStats.ts) | Subscribe, hydrate, reconnect, incremental events. | No periodic PR/Git computation in these hooks. Snapshot-time event buffers are arrays without an explicit bound in these modules. Add bounded keyed state buffering and revision-aware recovery before making more features depend on these events. |
| C05 | [Reviewer transcript](../../apps/web/src/components/review/MultiReviewReviewerTab.tsx) | Every 4 s while active and running/pending; manual refresh and state changes. | In-flight and generation guards, bounded returned tail (500 messages in service), terminal stop. Provider read/transfer still repeats; add revision/cursor reads. |
| C06 | [Validation output](../../apps/web/src/components/review/ReviewValidationStatus.tsx) | Completion-scheduled 2 s while output modal open and result queued/running. | Already scoped and guarded; use output offsets/unchanged responses if measurements justify it. |
| C07 | [Initialization logs](../../apps/web/src/components/terminal/InitializationLogs.tsx) | Every 1 s while mounted. | Guarded authoritative Docker tail capped to 500 lines; stale indicator after failures. Share reads across clients and skip identical output; retain Docker as recovery source. |
| C08 | [System meters](../../apps/web/src/components/layout/SystemUsageIndicator.tsx), [agent info](../../apps/web/src/components/layout/AgentInfoButton.tsx) | Title bar 5 s and hidden-document pause; agent popover 3 s; process popover 3 s. | Some overlap across consumers. Backend already coalesces pending system reads and caches GPU/RAM. Share client subscription and bounded completed samples; process list remains separately demand-driven. |
| C09 | [Docker availability](../../apps/web/src/App.tsx) | Startup, explicit retry, every 60 s. | In-flight guard; full environment sync only on availability recovery. Multiple clients may still ask independently. Share capability sampling without tying backend lifecycle to a renderer. |
| C10 | [Connection switcher](../../apps/web/src/components/sidebar/ServerConnectionSwitcher.tsx) | Active connection every 30 s and focus; inactive entries on demand with 10 s cache. | Reuse connection health evidence where semantically equivalent; retain authenticated readiness probes. Supersession fences results, but is not necessarily cancellation of the older request. |
| C11 | [Coordinator panel](../../apps/web/src/components/projects/CoordinatorPanel.tsx) | Visible document every 60 s, focus/visibility, turn completion and actions. | Reads Git state and coordinator snapshot; mount also requests fetch. No `coordinator` resource listener here or in global store binding. Add scoped change handling and guarded read scheduling. |
| C12 | [Design canvas](../../apps/web/src/components/design/DesignCanvasTab.tsx) | Active canvas: event/reconnect plus 3 s cursor check. | Serial refresh with trailing rerun; snapshot fetched on revision/reset. Preserve cursor backstop; trial longer quiet cadence and hidden-document suspension. |
| C13 | [Browser annotation](../../apps/web/src/components/browser/BrowserTab.tsx) | Every 150 ms during annotation mode. | Guarded; stops on completion/cancellation/inactive tab. An operation-scoped native event plus authoritative status could remove rapid polling. |
| C14 | [Cursor login](../../apps/web/src/components/settings/agent/CursorSdkSignIn.tsx) | Every 1.5 s only while pending. | Correct backend ownership; refresh callback lacks its own in-flight gate. Small candidate for shared completion-scheduled reads. |
| C15 | [Elapsed clock](../../apps/web/src/hooks/useElapsedTimer.ts), [prompt countdown](../../apps/web/src/hooks/usePromptDeadline.ts), BuildChatTab / MultiReviewTab / ClaudeTmuxChatTab | Usually 1 s; plan usage clock 1 min. | Presentation-only. Consolidate visible clock subscribers if measured render cost warrants it. Server approval expiry remains authoritative. |
| C16 | [Gateway client](../../apps/web/src/lib/native/web-gateway.ts), [terminal socket](../../apps/web/src/lib/native/terminal-websocket-client.ts), [native chat store](../../apps/web/src/stores/createNativeChatStore.ts) | Reconnect, channel retry, acknowledgement and batching timers. | Recovery/transport work, not domain polling. Share outage backoff policy only where semantics match; keep replay/generation/byte-credit contracts. |

## Inventory: bridges, desktop, maintenance, bounded waits

| ID | Source | Cadence / scope | Recommendation |
| --- | --- | --- | --- |
| L01 | [Gateway heartbeat](../../apps/backend/src/gateway-handlers.ts) | Shared 25 s tick; checks buffers and advances scoped stream cursor. | Keep. It is also replay convergence, not an empty cosmetic ping. |
| L02 | [Codex SSE](../../bridges/codex-bridge/src/index.ts), [Claude SSE](../../bridges/claude-bridge/src/routes/events.ts) | Codex checks every 5 s, sends at active 5 s / idle 30 s; Claude 30 s per connection. | Preserve protocol semantics; consolidate same-process timer ownership only if measured connection counts warrant it. |
| L03 | [Codex lifecycle](../../bridges/codex-bridge/src/app-server-runtime-lifecycle.ts), [bridge index](../../bridges/codex-bridge/src/index.ts) | Separate five-minute idle-session and index cleanup intervals. | Coarse, useful reclamation. Keep separate responsibilities even if one local maintenance clock drives them. |
| L04 | [Claude transcript persistence](../../bridges/claude-bridge/src/services/session-manager-persistence.ts) | Five-minute hydrated-transcript eviction sweep. | Keep no-touch background activity reads so eviction remains possible. |
| L05 | [Cursor server](../../bridges/cursor-bridge/src/server.ts), [Pi server](../../bridges/pi-bridge/src/server.ts) | One-minute idle sweep, ten-minute idle threshold; parent PID check every 5 s. | Timer handles are local to `start`; explicit `shutdown` does not clear these intervals. Standardize lifecycle ownership/disposal and repeated-start behavior. Process exit normally hides this; no production leak frequency is established. |
| L06 | [Shared parent watchdog](../../packages/protocol/src/parent-watchdog.ts) | Default 15 s, caller overrides; used by long-lived entrypoints. | Safety mechanism. Reuse implementation where appropriate while preserving each bridge's required detection time. |
| L07 | [ACP HTTP server](../../bridges/acp-bridge/src/acp-server.ts) | 50 ms socket-disconnect check for every in-flight request, alongside socket/request events. | Strong measurement candidate for long requests. Prove event coverage on supported runtime before removing/restricting fallback. |
| L08 | [Bridge diagnostics](../../packages/protocol/src/bridge-diagnostics.ts) | 60 s diagnostic heartbeat / enabled usage accumulator flush. | Low priority; retain bounded content-free observations. |
| L09 | [Application logging](../../apps/desktop/electron/application-logging.ts) | Startup + six-hour retention sweep. | Already coarse and appropriately owned. |
| L10 | [Toolchain manager](../../apps/desktop/electron/toolchain-manager.ts), [Claude preferences](../../bridges/claude-bridge/src/services/session-preferences.ts) | Lock heartbeat while holding operation ownership. | Keep safety deadlines; clean handles on every exit path. |
| L11 | [Test admission](../../scripts/test-admission.ts), [host scheduler](../../packages/protocol/src/host-test-scheduler.ts) | 500 ms channel heartbeat, 100 ms admission polling while waiting. | Development/validation process only; do not count as idle desktop overhead. Preserve shared host capacity. |
| L12 | [iOS web readiness](../../apps/ios/OrkestratorMobile/Views/RemoteWebView.swift) | At most 100 checks with 100 ms waits after navigation; requires two successful checks. | Bounded startup readiness, not continuous application polling. Keep cancellation/generation fencing. |
| L13 | [Server health](../../apps/backend/src/core/commands-server-health.ts), [desktop backend startup](../../apps/desktop/electron/backend-process.ts), tmux mode/start helpers, Docker setup scripts | Operation-scoped readiness/retry waits. | Preserve finite attempts/deadlines. Inspect separately from steady-state optimization. |
| L14 | [PTY coalescer](../../apps/backend/src/core/pty.ts), [terminal history](../../apps/backend/src/core/terminal-history.ts), [Codex coalescer](../../bridges/codex-bridge/src/messages/coalescer.ts), recorder/persistence and UI draft modules | Data-triggered flush/debounce/retry. | Useful batching; preserve maximum latency, bounded buffers, shutdown flush, and rejection handling. |

Other `while` loops include stream consumption, bounded parsing, pagination, and
queue draining. They are not automatically polling. UI focus, tooltip, copy
feedback, long-press, scroll animation, and the bounded 50 ms viewport search
in `useScrollLock` should not enter the backend recurring-work scheduler.
The source scan found no separate recurring PR/file engine in the iOS wrapper,
public web bootstrap, or CLI; those reach the web/backend owners above.

## Detailed findings

### F01 — File responses can be small while the underlying work repeats

`get_local_git_status` and `get_git_status` check `cachedChanges` with a 3,000 ms
maximum age. A miss runs the scanner outside `DiffStatsService.request` and
then calls `adoptScan`. The panel's 5,000 ms interval therefore cannot normally
reuse its own previous read, even in a quiet worktree. Other scans can happen
between reads and produce hits, so this is not a claim that every read misses.

The in-flight guard is per hook; multiple clients and the background service
can still enter distinct scanners. `adoptScan` receives no captured mutation
generation, unlike the service's own scan. A delayed external scan consequently
lacks the same cache-publication fence; add a regression test before claiming
a reproduced stale-data defect.

File-tree commands build the tree before `conditionalSnapshot` compares its
digest. Unchanged responses save transport/rendering, but do not by themselves
save the walk. The existing aggregate diff event is insufficient to invalidate
file lists: two different changed-path sets can have identical counts.

Recommendation: one read owner per target/comparison/options; join concurrent
reads; advance a file-list revision on semantic list changes independently of
aggregate statistics; maintain a separate tree revision for directory changes.
Use watcher invalidations plus bounded fallback freshness and explicit refresh.
Do not turn arbitrary historical cached data into authoritative current data.

### F02 — Container scans still combine network fetch and local worktree work

`buildContainerGitStatusScript` runs `git fetch origin "$ref"` for each status
scan. Local scans instead use `GitFetchScheduler`. The container path therefore
can repeat remote attempts at the 15-second background cadence and five-second
panel cadence. Even an immutable comparison commit currently traverses the
container fetch attempt path. Actual successful network requests depend on ref,
remote, credentials, and Git behavior.

Recommendation: separate target resolution/fetch from status collection. Apply
bounded per-container-generation/repository/ref freshness and single-flight
fetches, skip fetch for locally available immutable commits, and invalidate
after push/merge. Preserve missing-baseline errors and offline local results.
Do not share cache keys across unrelated clones or credentials.

### F03 — Terminal PR discovery and open PR monitoring share one cadence

`sync` tracks ready targets with any stored PR URL. `dropIfUnmonitorable` retains
any entry with a URL. A persisted terminal result returns pending modes to
normal, so ready merged/closed environments continue at 20 seconds. Detection
deliberately switches those targets to branch discovery, allowing replacement
PRs and reopening to be observed. These are real requirements, not dead code.

Recommendation: distinguish active PR monitoring, terminal side-effect repair,
and low-frequency branch discovery. Trial terminal discovery at five minutes,
with immediate explicit/user/agent-completion wakeups. Persist or reconstruct
unfinished task linkage/comments/merge cleanup before reducing retry frequency.
Do not permanently stop closed-PR observation without a replacement mechanism.

### F04 — Per-entry guards leave aggregate bursts possible

PR and diff entries schedule independently, with no service-wide admission limit
in those services. Environment restoration can align many due times. Workflow
ticks use `Promise.all` across selected records, so per-record locking prevents
duplicates for one record while allowing many different workflows to progress
at once. This is a scalability risk; no measured resource exhaustion is claimed.

Recommendation: bounded, fair admission by workload class and target identity,
with jitter on soft deadlines. Keep approvals, cancellation and lease renewal
out of queues occupied by Git/network maintenance. Saturation coalesces hints
and records required reconciliation; it must not silently drop authoritative
events or durable workflow obligations.

### F05 — Renderer scheduling remains fragmented

The native hook's tab-active condition is not browser document visibility.
Its frequent refresh can coexist with native-session invalidations. The Files
panel, process/agent info popovers, reviewer transcript and login paths have
different visibility, retry, and overlap policies. System readings are requested
from more than one component even though lower-level caching already helps.

Recommendation: a small client read coordinator, keyed by connection generation
and resource identity, with subscriber demand, in-flight joining, one pending
invalidation, hidden/offline suppression, and immediate visibility recovery.
Initially preserve current foreground cadences. Then trial idle backoff only
after measuring approval/completion visibility latency for every provider.
The existing [data-saving proposal](../todo/remote-client-data-saving-mode.md)
should use this coordinator rather than introduce a second scheduling layer.

### F06 — Backend sweeps mix discovery, progress, and maintenance

The two-second callback in `index.ts` starts several independently coalesced
operations. Native launch/queue scans use a separate two-second interval. Build,
looped review, and multi review repeatedly enumerate stored workflow records;
looped review already avoids repeated deep validation by revision, and feature
planning already asks for active records. Thus storage enumeration, parsing,
validation, provider observation, and actual state transitions must be measured
separately; an enumeration is not necessarily a physical disk read.

Recommendation: retain domain state machines and durable fences, but maintain
rebuildable active/pending indexes and explicit due times. Storage mutations,
provider transitions, workflow-result commits and queue enqueues wake only
affected keys. A slower discovery sweep repairs missed wakeups. Do not blindly
slow the four-second mail presence TTL or lease-sensitive operations.

### F07 — Recovery channels need stronger bounds before polling is reduced

PR/diff hooks subscribe before snapshot reads and buffer live events, which is
the correct ordering. However, their `bufferedEvents` arrays have no explicit
count/byte ceiling in the hooks. A hung snapshot plus ongoing changes can retain
an increasing buffer. Their domain payloads also do not carry their own
generation/revision; gateway replay provides protection on some transports,
but the domain consumers should not assume all native transports do so.

Recommendation: bounded per-target coalescing, separate transition notification
handling, snapshot generation/revision fences, and an explicit reconcile-required
state on overflow. State convergence and optional toasts are different contracts.
The five-minute persistent-resource manifest currently does not cover these
ephemeral views; add a compact compatible reconciliation route, not a second
blind full-state polling system.

### F08 — Existing events can replace some view polling

The resource contract includes `coordinator`, but `CoordinatorPanel` and global
store binding do not subscribe to it. External coordinator changes can therefore
wait for a 60-second read, focus, or another refresh path. Git state still needs
its own watcher/probe because not all changes pass through storage.

Browser annotation checks every 150 ms while a user operation is active;
native completion/cancel/error notifications with a snapshot fallback would
reduce requests. Design canvas already has an event-plus-cursor approach; keep
that structure and make quiet/hidden scheduling consistent.

### F09 — A few lifecycle timers deserve targeted cleanup

Cursor and Pi server startup retains idle/parent-watch handles only in local
variables; shutdown does not clear them. ACP installs a 50 ms disconnect poll
per request despite registering disconnect events. These are concrete source
patterns worth improving, with runtime regression tests. Do not remove ACP's
fallback until its reason and event coverage are demonstrated on supported Bun
versions, including long-polling requests and proxy disconnects.

### F10 — Observability should determine the final cadence

The repository already has gateway/bridge telemetry and bounded diagnostics;
extend those. Timer counts alone cannot distinguish a cheap map lookup from a
Docker exec, full file walk, process scan, external request or persisted write.
Record per job kind: requested/running/coalesced/completed/failed, duration,
queue delay, changed/unchanged outcome, work units, bytes, cache hits and actual
freshness. Keep dimensions finite; exclude paths, branch names, prompts,
transcripts, credentials and command output.

## Cost model and validation priorities

These are cadence-derived upper approximations for short successful operations,
not runtime measurements. Completion-scheduled jobs run less often when slow.

| Scenario | Nominal schedule pressure |
| --- | --- |
| 20 eligible normal PR entries | About 60 detection cycles/minute; open entries can add up to 20 check-rollup attempts/minute. Terminal discovery may also read the live branch. |
| 20 unwatched/container diff entries | 80 background scans/minute, before foreground misses and manual refreshes. |
| One open Changes panel | 12 read attempts/minute/client; separate cache hits and actual scans must be counted. |
| One active native tab | 120 refresh attempts/minute/client; idle 40. Each attempt is not necessarily one wire/provider request. |
| Build + looped review + multi review + feature planning services | 40 + 60 + 60 + 60 = 220 nominal tick requests/minute, even if individual ticks discover no runnable work. |
| One long ACP request | 20 disconnect checks/second while the request remains in flight. |

Benchmark idle and active workloads with 1/10/50 environments, local/container
mixes, one/two clients, many completed workflows, hidden documents, provider
outages and slow scans. Record CPU, process spawn/exec counts, bytes, reads and
writes alongside freshness and approval/completion latency. Use isolated
fixtures, not the user's production environment.

## What should remain

Keep backend authority for background work, snapshot recovery, revision/generation
gap detection, bounded replay, no-touch activity routes, independent leases,
fail-closed approvals, exact terminal recovery, and at-most-once dispatch. Keep
coarse reclamation, startup recovery, short bounded readiness checks, and
content-triggered batching where they already fit their purpose.

Do not introduce a distributed queue, mandatory webhook server, extra database,
or one scheduler spanning backend/bridges/browser merely to reduce timer count.
Use small scheduling primitives within each owning process. A GitHub webhook
integration or container-side watcher may be a later measured experiment; both
add lifecycle, authentication and recovery responsibilities.

## Proposed delivery sequence

The [plan index](../improvements/recurring-processes/plan/00-index.md) contains
12 implementation steps with dependencies, source targets, tests and rollback:
baseline; scheduling primitive; shared file reads; container fetch policy; PR
policy; client scheduling; agent observation; workflow/queue scheduling;
secondary UI reads; lifecycle/transport maintenance; recovery bounds; final
performance and reliability qualification. Steps that reduce recovery polling
must wait for the recovery contract to pass its tests.
