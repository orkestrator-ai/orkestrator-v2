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
  workflows, build pipelines, prompt queues, agent mail, native agent sessions
  and their display tails, compose and file drafts, handoffs, workflow
  results, the pane layout.

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
build-pipeline and looped-review claims, not by environment; deleting them by
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
7. Clean up claude-tmux sessions while the container and worktree still exist.
8. Containers: drain a running container's processes, then run the
   `container`, `volumes` and `network` steps.
9. Stop local servers, then run the `worktree` step and, only if it
   succeeded, the `branch` step.
10. Delete environment-keyed records, design canvases and web annotations;
    delete the schedules its agents own and pause other owners' schedules
    aimed at it ([scheduled-jobs.md](scheduled-jobs.md#when-the-owner-or-the-target-goes-away)).
11. Remove the environment record, then run the `state-dirs` step (bridges are
    already stopped, so nothing is writing there) and delete the pane layout.
12. Close any terminal that became visible during deletion and release
    watchers and monitors.

A successful deletion then schedules a reconcile pass for whatever earlier
deletions left pending.

The tombstone survives a crash. At startup, after orphaned local servers and
claude-tmux runtimes are reaped, every environment still marked `deleting` is
re-admitted to the ordinary delete path, which is idempotent.

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
  steps and redacted error. The cap and its predicate,
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
  project checkout or registered worktree claims, and that hold nothing but
  directories and `**/.turbo/turbo-*.log`. The walk never follows symlinks and
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

Creation cannot collide with these sweeps: it never reuses an existing path or
branch name, and each environment gets a fresh namespace. Worktree directories
holding real files and branches that fail every policy check are never swept;
their ownership cannot be proved from disk.
