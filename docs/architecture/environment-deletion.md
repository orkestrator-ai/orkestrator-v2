# Environment deletion

Deleting an environment removes everything Orkestrator created for it.
Anything a failed, interrupted or older deletion left behind is found and
removed later without user action. Nothing is removed unless Orkestrator can
prove it owns it, and no unmerged work is discarded.

Two mechanisms do this, deliberately kept apart:

- **Delete-time completeness.** `deleteEnvironment` removes everything in
  scope, in an order that cannot re-create what it has just removed.
- **Ledger-driven reconciliation.** Before any destructive step, deletion
  records exactly what it will remove. Steps that fail stay in the ledger and
  a reconciler retries them. Sweeps clear state whose owner is provable from
  its name alone, which covers leftovers from before the ledger existed.

Paths below are relative to `apps/backend/src/core/`.

| File | Purpose |
| --- | --- |
| `commands-servers.ts` | `deleteEnvironment` and `deleteEnvironmentTask` (the queued entry point, also used by merge cleanup) |
| `environment-cleanup-ledger.ts` | `EnvironmentCleanupLedger`, `ENVIRONMENT_CLEANUP_STEPS`, sweep state |
| `environment-cleanup.ts` | `buildEnvironmentCleanupEntry`, step runners, `cleanupEnvironmentBranch`, error redaction |
| `environment-cleanup-reconciler.ts` | Reconciler, retry scheduling and every orphan sweep |
| `environment-state-paths.ts` | The per-environment data-directory roots and their key scheme |
| `commands-terminal.ts`, `pty.ts` | `terminateTerminalSessionsForEnvironment` and the PTY handle's `terminate()` |
| `watch-host.ts` | Directory watches on macOS, held in a helper process so they cannot block the event loop |

Container removal, recovery copies, storage volumes and the environment
network are described from the container side in
[container-lifecycle.md](container-lifecycle.md). Where all this leaves disk,
and what is not pruned automatically, is in
[disk-usage.md](../development/disk-usage.md).

## Scope

Deletion owns state Orkestrator itself creates and names for an environment:

- the environment's container, its recovery copies, its storage volumes and
  its Docker network;
- the worktree and the local branch Orkestrator created for it (local
  environments only; a container environment has no host branch);
- processes spawned in the worktree: terminals, the setup PTY, exec and
  validation workers, local servers, claude-tmux sessions;
- per-environment data-directory state: the bridge state roots below,
  terminal histories, OpenCode command-change journals, design canvases, web
  annotations, preview definitions;
- environment-keyed store records: sessions, looped and multi-review
  workflows, build pipelines, graph runs with their artifact and effect records, prompt
  queues, agent mail, native agent sessions and their display tails, compose
  and file drafts, handoffs, workflow results, the pane layout;
- graph runs' reference artifacts in the workspace
  (`.orkestrator/graph-artifacts/<run-id>/`);
- isolated graph branches' worktrees in the workspace
  (`.orkestrator/graph-branches/<run-id>/`) and their Git branches
  (`orkestrator-graph/<run-id>/…`, in the shared repository for a local
  environment).

On a merged PR it also deletes the remote head branch through the GitHub API.

Out of scope, even when the environment caused it to exist:

- Agent CLI transcripts and caches (`~/.claude/projects`, `~/.codex/sessions`,
  OpenCode's database). Their owners manage retention.
- Git bookkeeping beyond the environment's own branch: remote-tracking refs
  and repository-wide config.
- Docker build cache and images. Environments create no per-environment
  images.
- Development-tooling state (dev profiles, `.turbo` caches, managed agent
  toolchains), which has its own pruning.
- Worktrees and branches Orkestrator did not create, even inside the
  workspaces root.

Deletion also keeps some records that mention the environment but belong to
something that outlives it: feature plans, coordinator workflow associations,
MCP management operations (retired by design), and the agent interaction
resolution journal. The journal's entries are fencing records keyed by
build-pipeline claims, not by environment; deleting them by
inference could allow a duplicate resolution, so they are left to the
journal's own time and size pruning.

### Per-environment state roots

Bridges write session and checkpoint state under the data directory, one
child per environment in each of `ENVIRONMENT_STATE_ROOTS`:
`pi-bridge-sessions`, `pi-bridge-state`, `cursor-bridge-state`,
`acp-bridge-state`, `portable-inputs` and `mcp-environment-overlays` (a
container environment's own MCP changes, see
[`mcp-management.md`](mcp-management.md#containers)). The child is named by
`environmentStateKey`: the first 32 hex characters of
`sha256(environmentId)`, which keeps environment ids out of paths that bridges
may log. The spawn path and every cleanup path use
`environmentStateDirectories`; a drift between them would strand state that
nothing else references, so a unit test pins the scheme.

Coordinator conversations run the same bridges under
`coordinatorRuntimeId(workspace, conversation)`, so their state sits in the
same roots under the same hash.

## Deletion order

`deleteEnvironmentTask` refuses at shutdown, during a merge, or while a
deletion is already running, then reserves the deletion (local-server starts
consult it) and runs `deleteEnvironment` on the environment lifecycle queue.
Inside the local-server queue:

1. Refuse a lifecycle record written by a newer version, and assert container
   ownership.
2. Write the deletion tombstone (`deletionRequestedAt`, `lifecycleOperation:
   "deleting"`). Queue and pipeline saves check it under their own locks, so a
   later write is rejected even if cleanup pauses or fails.
3. Record the ledger entry.
4. Revoke agent tool access, stop review validation and exec workers.
5. Terminate every terminal tree, including setup's build descendants,
   through the PTY handle's `terminate()`: a process-group signal, then a
   wait, with a kill after the grace period. If any tree survives, deletion
   throws and can be retried; it never removes a worktree a process is still
   writing into.
6. Delete terminal histories and, on a merged PR, the remote branch.
7. Remove the environment's graph runs' reference artifact directories
   (`removeEnvironmentGraphArtifactFiles`), on the host through the
   pinned-root remover and in a running container through the pinned
   in-container remover, so they also go from a worktree deletion keeps. Then
   remove the isolated branch worktrees and branches of every run that had
   isolated nodes (`removeEnvironmentGraphBranchWorktrees`, item 403): a local
   environment's branches live in the shared repository and would outlive the
   worktree otherwise. Then clean up claude-tmux sessions while the container
   and worktree still exist.
8. Containers: drain a running container's processes, then run the
   `container`, `volumes` and `network` steps.
9. Stop local servers, then stop watching and scanning the worktree
   (`diffStats.pauseForRemoval`), fence new file-list and tree reads across aliases,
   and wait for already-admitted reads and physical scans of that worktree
   (including ad hoc committed-only and alternate-ref reads). Reader ownership
   survives cache invalidation. Only then run the `worktree` step and, if
   it succeeded, the `branch` step. The tombstone keeps a later diff tracking
   reconciliation from tracking the environment again, so nothing watches a
   tree while it is removed. The `worktree` step first stops the worktree's
   git fsmonitor daemon, if any
   ([git-scan-caches.md](git-scan-caches.md#stopping-daemons)).
   A project home has no worktree scheduled for removal: only its own tracking
   pauses, leaving the retained checkout and other owners readable. A removal
   fence stays closed after physical removal, including while ledger steps are
   pending. Once both deletion and its ledger finish, tracking a replacement
   environment at that path retires the fence. Late file/tree reads alone
   cannot reopen it or recreate the retired directory. Reconciler completion
   grants the same replacement admission after failed cleanup is retried.
10. Delete environment-keyed records (graph runs together with their artifact
    rows), design canvases and web annotations;
    delete the schedules its agents own and pause other owners' schedules
    aimed at it ([scheduled-jobs.md](scheduled-jobs.md#when-the-owner-or-the-target-goes-away));
    delete its environment-scoped permission rules and their application
    record ([permission-rules.md](permission-rules.md)).
11. Remove the environment record, then run the `state-dirs` step (bridges are
    already stopped, so nothing is writing there) and delete the pane layout.
12. Close any terminal that became visible during deletion and release
    what is left of its monitors and tracking.

A successful deletion then schedules a reconcile pass for whatever earlier
deletions left pending.

`deleteEnvironment` lives in `environment-delete.ts`. As it reaches each stage
it records which one on the environment record (`deletionStep`):
`stopping-work` (with the tombstone), `terminals`, `workspace-files`,
`container`, `local-servers`, `worktree` and `records`
(`ENVIRONMENT_DELETION_STEPS` in `@orkestrator/protocol/node-summaries`). The
record write is best-effort: a failed one never stops the delete.

The two stages whose work runs in child processes, `container` (the drain and
the `container`, `volumes` and `network` steps) and `worktree` (the `worktree`
and `branch` steps), have a deadline (`environment-deletion-steps.ts`): 10 and
20 minutes. When one fires, the stage's signal kills every command it is
running, including the confined-removal helper, and starts no new one. The
command runner uses `waitForTermination` and `waitForDescendants` for these
stages: cancellation, command timeouts and output overflow retain the delete
guard until leader exit (or the lost-exit zombie fallback) and no live members
of the private process group are confirmed. Unknown termination keeps the guard
held; sending SIGKILL alone never admits a retry. The confined-removal helper
also waits for exit. The delete's reason is a fixed message naming the stage
("Deletion stopped while removing the worktree: it took longer than 20 min. Retry to continue."). The
ledger keeps the interrupted step pending. Each command also keeps its own
timeout; the deadline requests cancellation of the stage as a whole. Waiting
for confirmed termination can extend beyond that deadline.

This confirms local Docker CLI termination only. Docker may continue a drain or
removal request it already accepted after its client is killed. No new local
command starts after cancellation. Interrupted resource steps remain in the
ledger, and Retry probes current daemon state and ownership before continuing;
already-absent containers, volumes and networks are treated as removed. A CLI
exit is not a claim that daemon-side work has stopped.

The deadlines are generous on purpose: six fixture worktrees of 75,608 files took 17.2 s to remove together
on a loaded Mac, and a deadline that fires on a genuinely large tree only makes
the user retry the same work. Stages that run in the backend itself (terminal
teardown, store writes) have no deadline: nothing could prove them stopped.

The tombstone survives a crash. At startup, after orphaned local servers and
claude-tmux runtimes are reaped, every environment still marked `deleting` is
re-admitted to the ordinary delete path, which is idempotent.

Deletes of different environments run side by side: the lifecycle and
local-server queues are per environment, and a stuck delete holds up only its
own.

### When a delete fails or is slow

A delete that throws keeps its tombstone and `lifecycleOperation: "deleting"`,
because restart recovery starts from them, and records its reason in
`deletionError` (and in `cleanupAfterMergeError` for a merge cleanup). The
tombstone alone therefore does not mean a delete is running. Clients ask
`environmentDeletionFailure` (`@orkestrator/protocol/node-summaries`): with a
reason recorded the row stops spinning, shows the reason and offers **Retry**,
which is the ordinary delete. A delete clears `deletionError` before it does
anything else, and a restart still retries it. Node summaries carry this as
`deleting: true` for every tombstone, including failed deletes, so availability
filters keep fencing them. `deleteFailure` is a fixed, content-free message; raw
errors stay on the owning machine. Rows suppress the spinner when that field is
present. The bound machine view uses the same failure and tombstone helpers.

A delete with no failure past two minutes says so under its name, with the
stage it is on ("Still deleting after 4 min: removing the worktree", from
`lifecycleOperationStartedAt` and `deletionStep`, relayed as `deletingSince` and
`deletingStep`). `environmentDeletionStep` answers only for a running delete
and only for a stage this version knows: a failed delete shows its failure
instead, and a stage a newer machine relays is left out rather than shown raw.
A failed delete keeps `deletionStep`, so the record still says where it stopped.

An agent-test profile (`ORKESTRATOR_AGENT_TEST_ISOLATED=1`) can stage a real
failure on demand (`agent-test-fixtures.ts`): while
`<data dir>/agent-test-fixtures/terminal-survives-terminate/<environment id>`
exists, that environment's terminals are left running through a delete and
reported as survivors, which is how a process outliving SIGKILL fails it.
Removing the marker lets the next attempt terminate them. Outside agent-test
profiles the directory is never consulted.
`e2e/agent-testing/environment-delete-retry.spec.ts` uses it to delete from
the row's menu, see the failure across a reload and finish with **Retry**.

`scheduleMergeCleanupRecovery`, called by the PR monitor on every poll, stands
aside while a merge or delete in this process holds the environment: the owner
records any failure itself. Those guards live in memory, so after a restart
they are clear and recovery finishes the delete. A recorded
`cleanupAfterMergeError` still waits for a manual retry.

### Watches and the event loop

Bun keeps every directory watch of a process in one FSEvents stream. Each
`fs.watch` or `close()` makes its FSEvents thread rebuild that stream, holding a
lock across calls into `fseventsd`, and the next call on the JavaScript thread
waits for the lock. With `fseventsd` busy, as it is on a Mac where agents rewrite
thousands of files, one call blocks for seconds, and the rebuild covers every
other environment's watches too. Every timer, request and child-exit callback
waits with it, so the deletes queued behind appear stuck.

A standalone Bun process starting and closing 40 recursive watches on its own
empty directories, in the conditions below, spent 109 s in the starts (up to
9.4 s each) and 11.9 s in the closes (up to 4.3 s each). A `sample` during the
starts had the main thread in `_os_unfair_lock_lock_slow` and the `CFThreadLoop`
thread in `FSEventStreamStart`, `register_with_server`, `f2d_register_rpc`, in
every one of its samples.

On macOS the watches therefore live in one helper process (`watch-host.ts`,
started with `bun -e`). The backend only exchanges messages with it, so a start
or close returns at once and events arrive as bounded batches. A watch reports
`established` once the helper's `fs.watch` has returned; until then its watcher
is not `qualified` and its owner keeps polling. A lost helper fails every open
watch, whose owner falls back to polling and retries; the next start spawns a new
helper. Linux keeps `fs.watch` in the backend: inotify has no shared stream to
rebuild.

The helper takes the blocking out of the backend; it does not make `fseventsd`
any faster. With it at 100% of a core, independent Bun and Node processes writing
one new file a second each saw their first event 72 s in, and about 44 events for
the first 107 files, so `established` does not prove that a later change will be
reported. Events stay hints, and the owner's safety scan (every 120 s for a
local worktree) covers what they miss.

`established` deliberately stays "the helper's `fs.watch` returned" rather than
"an event has arrived" (todo 6120, task 5). On 2026-11-06, on an 18-core Mac
(macOS 27.2, load average about 14, `fseventsd` sampled at 3-58%), 20 watches
through the real helper, each writing a new file every 20 ms from the moment
`established` resolved, missed one of 5,000 files: the first file of one watch,
written 22 ms after `established`. The first event reached the backend 38-102 ms
after `established`. The gap a probe write would close is tens of milliseconds
on an ordinary host, while under a saturated `fseventsd` events are lost after
the stream is running as well, which only the safety scan covers. A probe would
also leave every watch unqualified on a host that delivers nothing.
`watch-host-events.live.test.ts` proves delivery through the real helper by
repeating each change until an event names it.

Measured on an 18-core Mac (macOS 26.6.2, 128 GB) with `fseventsd` at about 100%
of a core throughout, on an isolated `dev:test` profile with 130 idle local
environments. Each deleted environment was a fixture worktree plus an APFS clone
of this repository's `node_modules`, 75,608 files in all. Deletes went through
the CLI, and lag comes from the backend's `/__orkestrator/metrics`.

| | Before | After |
| --- | --- | --- |
| Six deletes at once, total | 72.2 s | 15.9 s |
| Six deletes at once, each | 32.0 s for three, 72.1 s for three | 15.9 s for all six |
| Event-loop stalls during those | 16.2, 24.7 and 14.5 s | None over 100 ms |
| Slowest metrics request during those | 25.0 s | 54 ms |
| One delete | 5.2 s | 3.8 s |
| Event-loop stalls during it | 1.7 s | None over 100 ms |
| Longest stall since the backend started | 662.6 s | 251 ms |

That last row covers startup, when the backend starts a watcher for each of the
130 worktrees: before the fix it could not answer the CLI for several minutes
after it reported ready.

Before is the same benchmark with the four backend source files that hold the
watches and the delete order restored to their previous state. An earlier run of
the same six deletes, with timing added to each step, separated the costs:
`git worktree remove` took 17.2 s in child processes without stalling the
loop, and the six `untrack` calls that followed ran one after another as a single
54 s stall, their individual `close()` calls taking up to 18.1 s. The worktree
removal is still the bulk of what remains, and it does not hold the loop.

### The work a delete does besides watches

`scripts/benchmark-delete-store-work.ts` runs the real `delete_environment`
command in a temporary data directory with no watches, bridges or project
checkout. Every storage call is timed, store-row writes are counted, and a 5 ms
timer records event-loop gaps. Its store is heavy on purpose: 136 environments,
10 terminal sessions each, 2,000 native sessions with 200 dispatched request ids
each, 64 display tails of 1 MiB, and 200 mailboxes of 50 2 KiB messages (about
20 MiB of agent mail's 32 MiB limit). On the same Mac at a load average of
20-29, over five runs:

| | One delete | Five at once |
| --- | --- | --- |
| Duration | 0.48-0.51 s | 1.5-1.6 s each |
| Longest event-loop gap | 0.28-0.31 s | 0.61-1.10 s |
| Store rows written | 279 | 1,380 |

Earlier runs, with the host's 5- and 15-minute load averages near 67, gave gaps
of 1.1-1.3 s for one delete (two runs) and 4.4-5.2 s for five (three runs).

Two calls account for nearly all of it. `deleteNativeAgentSessionsByEnvironment`
takes 160-176 ms, 146-161 ms of it before it first yields, parsing every native
session to find one environment's. `deleteAgentMailByEnvironment` takes
116-131 ms to load and rewrite the whole agent-mail document. A CPU profile puts
that time in `readStore` and in `saveSensitiveJson`. SQLite calls are
synchronous, so neither call gives timers a turn, concurrent deletes run their
store tails as one block, and the gap grows with the number of deletes. Every other store call took under 10 ms per delete.

Since to-do 6120 task 6 neither call walks the whole store:

- **Native sessions** are owned by their environment in the store's indexed
  `owner` column, so the sweep lists one environment's keys without reading a
  value. Rows with no owner (written before the column was filled, or by an
  older build) sit in a partial index of their own and are parsed and checked
  individually; every open gives them their owner. A store held as a document,
  or buffered by an atomic scope, is still read whole.
- **Agent mail** is planned from the shared read model under the mail lease
  and committed as the rows it changes (`updateStoreRows`), with a turn for
  timers between the two. It no longer clones the store or reserializes
  mailboxes it does not change. How much it writes still depends on how many
  mailboxes hold mail the environment sent.

Measured on beelink (Linux, 16 cores, 62 GB) on 2026-11-09 with the same
workload, the base commit and this change run alternately, five times each,
with a load average of 49-56 from other work on the host:

| | Before | After |
| --- | --- | --- |
| Native-session sweep, one delete | 205-336 ms, 181-293 ms of it without yielding | 11-18 ms, 2-3 ms without yielding |
| Longest event-loop gap, one delete | 409-630 ms | 264-451 ms |
| Longest event-loop gap, five at once | 1.10-1.59 s | 0.37-0.42 s |
| Each of five concurrent deletes | 1.96-3.13 s | 0.88-1.91 s |

Finding an environment's session keys alone took 0.3-0.4 ms against 140-180 ms
for the whole-store parse. The agent-mail call did not get faster in this
workload, because every one of its 200 mailboxes holds mail from every deleted
environment, so each delete has to rewrite them all. Timed alone (the store
call in a loop over six environments, three runs each, not the benchmark), with
that mail in three mailboxes, each call after the first took 4-35 ms against
36-210 ms. In the benchmark the agent-mail call is the largest store call left
(238-420 ms per delete in these runs); how its time divides between parsing
the read model and the rewrite was not profiled.

What the ticket's leads came to:

- **A recursive watch still open while `node_modules` is removed.** The order
  was wrong, but the events were not the cost. Before the fix,
  `git worktree remove` ran with its watch still open and did not stall the
  loop. The stall came from closing the watch afterwards, which the helper now
  does off the backend's thread.
- **`git worktree remove --force` on a large worktree.** It is slow, 17.2 s for
  six, and is most of what a delete still takes. It runs in a child process and
  does not stall the loop.
- **Store rewrites.** Partly. The environment store did not hold: its seven
  record writes per delete took 5-10 ms in all, and each cleanup-ledger write
  under 2 ms. The agent-mail document did hold: it is rewritten whole on each
  delete. Its cost depends on the size of
  the mail store, and is a fraction of a second where the watch stalls were tens
  of seconds.
- **Session and transcript stores.** Partly. Terminal sessions did not hold:
  their removal takes under 5 ms. Display tails did not hold either: their
  removal is part of the native-session call, which spends about 15 ms after its
  parse. The native-session store did hold, through the whole-store parse
  above. Transcript artifacts and media pins were empty in the benchmark, so it
  does not measure them.
- **Reconcile loops.** Did not hold. A cleanup-reconciler pass with nothing
  pending took 0.1 ms; with entries pending it runs the same cleanup steps as a
  delete. The activity sweep skips environments with `deletionRequestedAt`, and
  its snapshot reads took up to 101 ms, with a longest gap of 99 ms. So the
  `activity.reconcile-failed` batches in the reported logs were about other
  environments' bridge reads. They are logged without a message, so the logs do
  not say why those reads failed, and that was not established here.
- **Later deletes waiting before their bridges stopped.** The lifecycle and
  local-server queues are per environment, and a stuck delete holds up only its
  own (`commands-environment-cleanup.test.ts`). The wait was the stalled loop:
  before the fix three of six concurrent deletes took 72.1 s against 32.0 s;
  after it all six took 15.9 s.

The remaining store cost is
[6120](../todo/containers-and-environments/6120-environment-delete-follow-ups.md)
task 6.

## Cleanup ledger

The ledger is the `environment-cleanup-ledger` store in the backend database
(an envelope with one row per environment), written as one transaction per
mutation. An entry records:

| Field | Meaning |
| --- | --- |
| `projectPath`, `worktreePath`, `worktreeRoot` | The project checkout, the worktree, and the folder it was created in (the confinement root) |
| `branch`, `prMerged`, `createdFromCommit`, `baseBranches` | What the branch policy needs |
| `containerId`, `retainedContainers`, `volumes` | Docker resources, including recovery copies and retained storage |
| `stateDirectories` | Absolute paths from `environmentStateDirectories` |
| `pending` | Steps still owed, from `ENVIRONMENT_CLEANUP_STEPS`: `container`, `volumes`, `network`, `worktree`, `branch`, `state-dirs` |
| `attempts`, `lastAttemptAt`, `lastError` | Retry state; `lastError` is redacted to an errno code, exit status or fixed refusal text, never a path, command output or credential |
| `attemptedVersions` | Backend versions ordered by most recent attempt, newest last, at most 16; least-recently seen versions are evicted; absent in older entries |

- `buildEnvironmentCleanupEntry` schedules only what applies: `container`
  when there is a runtime or recovery copy, `volumes` when the lifecycle record
  names any, `network` for containerized environments, `worktree` when a path
  exists, `branch` only for a local environment with a worktree, and always
  `state-dirs`. The project home never schedules its directory or branch.
- Recording over an existing entry (a retried deletion) keeps what the earlier
  attempt still owed and unions the pending steps.
- Each step that succeeds removes itself from `pending`; the entry is dropped
  when nothing is pending. A failed step records `lastError` and stays
  pending. Step runners never throw, so the environment record is still
  removed on time.
- The ledger holds at most 1,000 entries; the oldest go first.

Every step is idempotent and confined:

- **Container.** Ownership is re-probed unless deletion verified it moments
  earlier. Recovery copies are each verified on their own. A container Docker
  has forgotten counts as removed.
- **Volumes and network.** Refused while `container` is still pending. A
  volume is removed (never forced) only while its owner and environment
  labels still match.
- **Worktree.** Refused unless the path resolves, before and after following
  symlinks, inside the recorded `worktreeRoot` (or the backend's worktree
  root for entries that predate it). Skipped if another live environment now
  uses the same path. `git worktree remove --force`, then
  `removeConfinedDirectory` for anything git did not remove, then
  `git worktree prune`. Fails if the directory still exists.
- **State directories.** Refused unless inside the data directory; removed
  with `removeConfinedDirectory`, so a symlink cannot redirect the removal.

## Branch policy

`cleanupEnvironmentBranch` deletes the local branch only when one of these
holds:

- the PR merged, `refs/remotes/origin/<branch>` exists, and the local tip is
  contained in it (commits made after the merge exist only locally, so a
  merged PR alone is not enough);
- the tip is contained in `createdFromCommit` (no commits of its own);
- the tip is contained in a merge target: the `origin/HEAD` target (or `main`
  and `master` when it is unset), local or remote-tracking, plus any recorded
  delegation base branch.

A branch checked out in any worktree is always kept. Only local refs are
consulted; the reconciler never fetches, so a stale remote-tracking ref can
only keep a branch, never delete one. Deletion uses `git branch -D` after a
check passes; `-d` judges against the upstream or the checkout's `HEAD` and
rejects squash merges. Anything else is kept, with one log line per
environment, and no setting deletes unmerged branches.

## Reconciler

`reconcileEnvironmentCleanup` retries ledger entries whose environment record
is gone (while it exists, interrupted-deletion recovery owns the delete). Each
entry runs through the environment lifecycle queue, so it cannot race
environment creation or shutdown draining.

- Steps run in `ENVIRONMENT_CLEANUP_STEPS` order. `branch` waits until
  `worktree` has succeeded, since a surviving worktree may still have it
  checked out.
- Retries back off by attempt count (`environmentCleanupRetryDelayMs`): 1
  minute, doubling, capped at 6 hours.
- After `MAX_ENVIRONMENT_CLEANUP_ATTEMPTS` (8) passes the entry is kept for
  inspection, no longer retried, and logged once per process with its pending
  steps and redacted error.
- An exhausted entry gets one more cycle of attempts from a backend version
  that has never attempted it (`rearmForVersion` resets `attempts` and
  records the version at once, so a version re-arms an entry at most once,
  and going back to an older version does not re-arm it). An upgrade is the
  likeliest fix for a failure that outlasted every retry. Entries from before
  versions were recorded are re-armed once by the first backend that reads
  them. The re-arm is logged; a failure the upgrade did not fix logs the
  "still failing" line again when the cycle ends. The cap and its predicate,
  `isEnvironmentCleanupExhausted`, live in `environment-cleanup-ledger.ts`;
  `disk:report` reads the store read-only through `parseEnvironmentCleanupLedger`
  and shows those entries in its `environment cleanup ledger` row (count,
  pending steps, redacted `lastError`, first environment ids), skipping
  entries whose environment record still exists, as the reconciler does.
- `scheduleEnvironmentCleanupReconcile` runs one pass at a time per data
  directory and re-arms an unreferenced timer for the earliest deferred retry.
  It runs at startup and after each successful deletion.

## Sweeps without a ledger

These remove state whose owner is provable without a ledger.
`runStartupEnvironmentCleanup` starts them at backend startup, after
interrupted-deletion recovery, and repeats them hourly. Anything modified in
the last hour (`ORPHANED_STATE_MIN_AGE_MS`) is skipped, which covers a
creation in progress. A failure to list owners aborts the sweep, because an
incomplete owner set would make live state look orphaned.

- **Bridge state** (`sweepOrphanedEnvironmentState`): children of the state
  roots whose name is a state key but not the key of any live or deleting
  environment, coordinator workspace or coordinator conversation.
- **Design canvases** (`sweepOrphanedDesignCanvases`): canvases whose
  environment is gone. When any canvas has an owner, a missing, corrupt or
  incomplete environment store aborts it. With no owned canvas it does not
  read the store, so a fresh data directory has nothing to refuse.
- **Web annotations**: `WebAnnotationStorage.init({ environmentExists })`
  deletes, rather than loads, stores whose environment is gone. A lookup that
  fails counts as existing.
- **Preview definitions**: registry startup reconciles every environment a
  stored definition names as well as every live one, and reconciling a
  missing environment drops its definitions.

`sweepPreLedgerDiskState` runs three stricter sweeps as one lifecycle
operation under the queue key `orphaned-disk-state-sweep`, so they get
shutdown admission and draining. Each fails alone and logs once per process.

- **Stray workspace directories** (`sweepStrayWorkspaceDirectories`):
  directories directly under the backend's worktree root
  (`getWorktreeBaseDir`) that no live or deleting environment, ledger entry,
  project checkout, registered worktree or chosen worktree folder claims, and
  that hold nothing but directories and `**/.turbo/turbo-*.log`. It also
  protects the folders Orkestrator chose for worktrees: each live environment's
  `worktreeBaseDir`, each ledger entry's `worktreeRoot`, and the Settings >
  Disk usage environment location unless the backend was started with
  `--worktree-dir`. Such a folder is used only if it still passes
  `validateWorktreeLocation` unchanged (canonical, no symlinked ancestor, not
  the filesystem root or inside a data directory) and is not inside a project
  checkout. Chosen folders are protected from the backend-root sweep, but
  their unknown children are never swept: a matching name is not ownership
  evidence. Exact recorded paths remain eligible for ledger cleanup. A future
  external stray sweep needs durable path ownership with identity checks.
  The walk in the backend root never follows symlinks and
  takes the newest mtime anywhere in the tree. Over 10,000 entries, or an
  unreadable tree, counts as content. A failed `git worktree list` for any
  project abandons the pass. Unowned directories kept for holding files are
  counted, and the count is logged when it changes.
- **Orphaned environment branches** (`sweepOrphanedEnvironmentBranches`):
  local branches in the environment naming scheme
  (`<slug>-<ns>[-r<N>][-<n>]`: revision 0 has no `-r`, and allocation can
  add up to two collision suffixes; `parseEnvironmentBranchNamespace` is the
  single definition, shared with `disk:report`). Protected: namespaces of live, deleting and
  ledger environments, their recorded `branch` and `delegationBaseBranch`,
  branches checked out in any worktree, the configured default branch and the
  `origin/HEAD` target. A pre-ledger branch has no PR state, so it goes through
  `cleanupEnvironmentBranch` with only the merge-target test and "no commits
  beyond its reflog `Created from` entry". Each project is swept at most daily
  (`ORPHANED_BRANCH_SWEEP_INTERVAL_MS`), at most 500 candidates per pass, with
  a cursor in the `environment-cleanup-sweeps` store for the rest.
- **Abandoned temp files** (`sweepAbandonedTempFiles`): only
  `<name>.json.<pid>.tmp` in the data directory whose PID is not running.
  Other shapes, such as `.coordinators.json.<uuid>.tmp`, are left alone.
- **Git mirrors of removed projects** (`sweepOrphanedProjectGitMirrors`):
  children of `<data dir>/git-mirrors` named like a project id that is not in the
  project store, over an hour old. A missing or invalid store aborts it
  (`loadProjectIdsForCleanup`). A mirror belongs to its project, not to an
  environment, so deleting an environment leaves it. See
  [Project Git mirror](container-lifecycle.md#project-git-mirror).

Creation cannot collide with these sweeps: it never reuses an existing path or
branch name, and each environment gets a fresh namespace. The namespace is a
prefix of the environment id (`environmentBranchNamespace`), and no creation,
move or restore path reuses another environment's id or namespace, so a
ledger entry, exhausted or re-armed, never blocks creation. Should a feature
ever reuse one, the steps still act only on exact recorded names (the
worktree path is skipped while a live environment claims it, the branch must
pass the branch policy, and state directories and the network follow the
environment id, whose entries are skipped while its record exists), but the
orphan sweeps would then protect the reused namespace's strays as owned. Worktree directories
holding real files and branches that fail every policy check are never swept;
their ownership cannot be proved from disk.
