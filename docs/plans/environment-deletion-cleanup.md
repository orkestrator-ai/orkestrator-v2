# Environment deletion leaves Orkestrator-owned state behind

Status: Implemented with automated verification on 2026-09-26; the isolated
real-stack deletion run in step 08 is outstanding.  
Prepared: 2026-09-26  
Source revision: `06af4d866806642399a918e818cd5eb5c43c7ad1`

## Intended outcome

Deleting an environment removes everything Orkestrator created for it, and
anything a failed, interrupted, or older deletion left behind is found and
removed later without user action. Nothing is deleted that Orkestrator cannot
prove it owns, and no unmerged work is discarded silently.

Paths below are relative to `apps/backend/src/core/` unless stated otherwise.
`<dataDir>` is `storage.getDataDir()`; `<hash>` is
`sha256(environmentId).hex.slice(0, 32)`.

## Scope

In scope: state that Orkestrator itself creates and names for an environment —
data-dir directories, JSON-store records, the worktree and its local branch,
the environment's container, and processes Orkestrator spawned in the worktree.

Out of scope: state owned by other applications, even when an environment
caused it to exist. Those applications manage their own retention.

- Agent CLI transcripts and caches (`~/.claude/projects`, `~/.codex/sessions`,
  opencode's database, and so on). Claude Code already prunes by
  `cleanupPeriodDays`.
- Git's own bookkeeping beyond the branch Orkestrator created: remote-tracking
  refs (`git fetch --prune` owns those) and repository-wide config.
- Docker build cache and images. Environments do not create per-environment
  images, networks, or volumes (see "Docker" below).
- Development-tooling state: `~/.config/orkestrator-v2-dev/profiles/*`
  (`mise run dev:reset` owns it), `.turbo` caches, and agent toolchain versions,
  which `toolchain-manager.ts` already prunes after 14 days.
- Worktrees and branches that Orkestrator did not create, even when they live
  in the workspaces root (for example a hand-made `wa-integration` worktree).

## What was observed

On the reporting machine, with 12 live environments:

| Leftover | Count | Size |
| --- | --- | --- |
| `<dataDir>/cursor-bridge-state/<hash>` for deleted environments | 188 of 191 | 2.11 GB |
| `<dataDir>/pi-bridge-state/<hash>` for deleted environments | 1 of 1 | < 1 MB |
| Worktree directory re-created after removal, containing only `bridges/cursor-bridge/.turbo/turbo-build.log` | 1 | < 1 MB |
| Local environment branches with no worktree | 5 (1 with commits not on `main`) | negligible |

Every registered git worktree belonged either to a live environment or to
something Orkestrator did not create, so worktree removal itself works when it
runs to completion.

## Findings

### F1 — Bridge state directories are never removed (high)

`commands-servers.ts:1097-1137` derives four per-environment directories when
spawning bridges: `pi-bridge-sessions/<hash>`, `pi-bridge-state/<hash>`,
`cursor-bridge-state/<hash>`, and `acp-bridge-state/<hash>/<kind>`. Nothing
else references these paths. `deleteEnvironment` (`commands-servers.ts:1407`)
does not remove them and no sweep exists. Cursor's directories hold run history
(`checkpoints.ndjson` reached 73 MB for one environment), so this grows without
bound.

### F2 — Processes spawned in the worktree can outlive its removal (medium)

`cleanupTerminalSessionsForEnvironment` (`commands-terminal.ts:760`) closes the
setup PTY (`<envId>:setup`) and terminal tabs through `pty.ts:220`, which calls
`spawned.kill()` on the direct child only, without a process-group signal and
without waiting. `removeLocalWorktree` runs immediately afterwards
(`commands-servers.ts:1465`). Setup runs `mise run setup`, whose bridge builds
(`mise.toml:156-165`) write `bridges/*/.turbo/turbo-build.log`. A surviving
descendant re-creates part of the tree after `git worktree remove` has
succeeded. Local servers already use `terminateProcessTree`
(`process-tree.ts:144`) and are awaited; terminals are not.

### F3 — The local branch is never deleted (medium)

Environments create their branch with `git worktree add -b`
(`commands-environment.ts:1420-1463`). Deletion removes only the remote branch,
and only for a merged PR (`deleteMergedEnvironmentRemoteBranch`,
`commands-environment.ts:1504`). `git branch -D` exists only in
`cleanupFailedLocalWorktree` (`commands-environment.ts:1524`) for failed
creation. Branch config written by `push.autoSetupRemote` remains with it.

### F4 — Best-effort steps leave orphans that nothing retries (medium)

These steps swallow errors, and the environment record is still removed
afterwards, so a failure is permanent:

- `docker rm -f` (`commands-servers.ts:1457`)
- worktree removal (`:1465`, `:1469`)
- sessions and buffers (`:1474`)
- web annotations (`:1513`)
- pane layout (`:1521`)

The existing recovery (`index.ts:694-705`) re-runs deletion only for records
still marked `deleting`. It cannot help once the record is gone.

### F5 — Environment-keyed records survive in some stores (low)

- `workflow-results.json` records carry `environmentId`
  (`workflow-result-service.ts:213`). They are only size-pruned (`:917`).
- `agent-interaction-resolution-journal.json` entries are only time/size-pruned
  (`storage-native.ts:197-221`).
- Design `legacy-backups/<id>.orkdes` (`design-records.ts:352`) is not removed by
  `remove()` (`design-records.ts:488`).
- `native-agent-display-tails.json` is cleared only when sessions were removed
  in the same call (`storage-native.ts:817`), so a retry after partial failure
  skips it.

### F6 — Leftovers from earlier failures are reloaded or kept indefinitely (low)

- `WebAnnotationStorage.init()` (`web-annotation-storage.ts:1280`) loads every
  directory under `web-annotations/`, including those of deleted environments.
- The preview registry reconciles only environments that still exist
  (`preview-service-registry.ts:291-292`). Definitions left by a crash between
  environment removal and the asynchronous listener remain in
  `preview-services.json`.

### Docker — no change beyond F4

Each environment owns one labelled container. The code creates no
per-environment networks, volumes, or images: network policy is passed as
container environment variables, and the only bind mounts are host credential
directories. The container removal gap is covered by F4. A manual
`cleanup_orphaned_containers` command exists (`commands-registry-docker.ts:363`).

## Design

Two mechanisms, deliberately separate:

1. **Delete-time completeness.** `deleteEnvironment` removes everything in
   scope, in an order that cannot re-create what it just removed.
2. **Ledger-driven reconciliation.** Before it starts destructive work,
   deletion writes a cleanup ledger entry naming exactly what it will remove.
   Each step marks itself done. The environment record is still removed on
   time, so the user-facing behavior of best-effort steps does not change. What
   failed stays in the ledger, and a reconciler retries it at startup and after
   each deletion.

The ledger is what lets the reconciler delete paths and branches safely: it
removes only what Orkestrator recorded as its own. For the bridge-state
directories, where the owner is provable from the name alone, a separate sweep
also clears history from before the ledger existed.

### Ledger entry

Stored in `<dataDir>/environment-cleanup-ledger.json` and written through the
same atomic-write path as other stores:

```ts
type EnvironmentCleanupEntry = {
  environmentId: string;
  recordedAt: string;
  projectPath: string | null;
  worktreePath: string | null;   // only when inside getWorktreeBaseDir()
  branch: string | null;         // the environment's current branch name
  branchPolicy: "delete-if-merged" | "keep";
  containerId: string | null;
  stateDirectories: string[];    // absolute, all under <dataDir>
  pending: CleanupStep[];        // e.g. "worktree", "branch", "container", "state-dirs"
  attempts: number;
  lastError: string | null;      // redacted: no paths, command output, or secrets
};
```

## Implementation steps

### 01 — Single source for per-environment state paths

- Add `environmentStateDirectories(dataDir, environmentId)` returning the four
  bridge directories from F1.
- Replace the four inline `path.join(... createHash ...)` derivations in
  `commands-servers.ts:1097-1137` with it.
- Add a unit test that pins the key scheme, so a future change to the spawn
  path cannot silently strand existing state.

### 02 — Terminate worktree processes before removal (F2)

- Give the PTY handle an awaited `terminate()` that signals the process group
  and its descendants, then waits. Reuse `terminateProcessTree`
  (`process-tree.ts:144`) with the same grace and kill budgets as local servers.
- In `deleteEnvironment`, await termination of the setup session and every
  terminal session for the environment before `removeLocalWorktree`. Keep the
  existing synchronous `cleanupTerminalSessionsForEnvironment` for the second,
  post-tombstone sweep at `:1525`.
- After worktree removal, if the path exists again, remove it once more and
  record `worktree` as pending in the ledger rather than looping.
- Regression test: a fake setup PTY with a child that writes into the worktree
  after SIGHUP. Deletion must leave no directory.

### 03 — Cleanup ledger and delete-time wiring (F1, F3, F4)

- Add ledger storage with load, upsert, mark-step-done, and remove. Remove the
  entry when `pending` is empty.
- In `deleteEnvironment`, write the entry immediately after the
  `deletionRequestedAt` tombstone (`:1429`) and before any destructive step.
  Populate it from the environment record and `environmentStateDirectories`.
- Convert the swallowed steps listed in F4 to mark their step done on success
  and record `lastError` on failure, still without aborting deletion.
- Add a `state-dirs` step after `removeEnvironment` (`:1520`) that removes the
  directories from 01. Do this after the bridges are stopped (`:1461`) so no
  bridge is writing to them.
- Refuse any ledger path that does not resolve inside `<dataDir>` or
  `getWorktreeBaseDir()`. Remove directories with `removeConfinedDirectory`
  (`path-safety.ts:679`) rather than a bare `fs.rm`, so a symlink cannot redirect
  the removal.

### 04 — Local branch removal with a no-data-loss policy (F3)

Delete the environment's local branch only when one of these is true:

- the environment's PR is merged (`prState === "merged"`), which covers squash
  and rebase merges; or
- `git merge-base --is-ancestor <branch> <default branch>` succeeds; or
- the branch has no commits beyond `createdFromCommit`.

Otherwise keep the branch, record `branchPolicy: "keep"`, and log it once. Use
`git branch -D` only after one of the checks above has passed. `-d` is not a
substitute: it checks against the branch's upstream or the project checkout's
current `HEAD`, not the default branch, and it rejects squash-merged branches. Refuse if the
branch is checked out in any remaining worktree. This applies to local
environments only; container environments have no host branch.

### 05 — Reconciler (F4, F6)

Run once at startup, after `reapPidServers` and interrupted-deletion recovery
(`index.ts:679-705`), and after each completed deletion. Run it through the
environment lifecycle queue so it cannot race environment creation.

- Retry every ledger entry's pending steps, with capped backoff by `attempts`.
- For entries still failing after the cap, keep them and surface a single
  diagnostic, rather than retrying forever on every start.
- Container step: remove the recorded container only if its Orkestrator owner
  and environment labels still match (`commands-containers.ts:135-151`).
- Do not delete anything the ledger does not name, except in step 06.

### 06 — One-time and ongoing sweeps for provable orphans (F1, F6)

These are safe without a ledger because ownership is provable from the name:

- **Bridge state:** list each of the four bridge roots and remove entries whose
  name is not the `<hash>` of any environment in `environments.json`, counting
  live and `deleting` records. Skip entries modified within the last hour to
  cover a concurrent creation. This backfills the 2.11 GB observed.
- **Web annotations:** skip, and then remove, directories whose environment ID
  is absent. Do this in `WebAnnotationStorage.init()` or in the reconciler,
  before `init()` loads them.
- **Preview definitions:** at registry `init()`, drop definitions whose
  environment no longer exists.

Worktree directories and branches from before the ledger are not swept. Their
ownership cannot be proved from disk, and the observed backlog is one empty
directory and five branches. Mention them in the release note instead.

### 07 — Store records (F5)

- `WorkflowResultService`: add `deleteByEnvironment(environmentId)` and call it
  from `deleteEnvironment`.
- Permanent canvas removal (`removeCanvasFiles`) also removes
  `legacyBackupFile(id)`. `DesignRecordStore.remove()` itself is unchanged,
  because it also discards provisional canvases.
- `deleteNativeAgentSessionsByEnvironment`: clear display tails for the
  environment unconditionally, so a retry after partial failure completes.

Not changed:

- `feature-plans.json` and coordinator workflow associations reference an
  environment but belong to the plan or coordinator, which outlives it.
- `mcp-management/operations.json` retires work for deleted environments by
  design (`mcp-management/service-apply-scope.test.ts:78`).
- `agent-interaction-resolution-journal.json`. Its entries carry no
  environment ID: they are fencing records keyed by build-pipeline and
  looped-review claims, and deletion already removes those workflows. The
  journal is time- and size-pruned. Deleting fencing entries by inference
  risks a duplicate resolution, which is worse than a bounded leftover.

### 08 — Tests and verification

Extend `commands-environment-cleanup.test.ts` (the existing
`delete_environment durable child-state cleanup` suite):

- bridge state directories are removed for all four kinds;
- the ledger entry is written before the first destructive step and removed on
  success;
- a failing `docker rm` or worktree removal leaves a ledger entry, and the
  reconciler completes it on the next run;
- the branch is deleted when merged and kept when it has unmerged commits;
- the reconciler refuses paths outside `<dataDir>` and the workspaces root;
- the bridge-state sweep keeps live, `deleting`, and recently modified entries.

Plus the F2 regression test from step 02, and unit tests for step 07's store
changes.

For real-stack verification, run in an isolated dev profile
(`mise run dev:test`). Create a local environment whose setup runs the bridge
builds, delete it mid-setup, and confirm:

- no worktree directory remains;
- no `*-bridge-state/<hash>` remains;
- the branch follows the policy;
- the ledger is empty.

## Decisions

1. **Branch policy.** Unmerged branches are kept, with one log line per
   environment. No setting allows deleting them.
2. **Surfacing permanently failing cleanup.** A single warning per entry and
   process once `MAX_ENVIRONMENT_CLEANUP_ATTEMPTS` (8) is reached; the entry
   stays in the ledger for inspection. A diagnostics-surface entry is a
   possible follow-up.

## Implementation notes

Where the code differs from, or adds to, the steps above:

- **Coordinator state shares the bridge roots.** Coordinator conversations run
  the same bridges under `coordinatorRuntimeId(workspace, conversation)`, so
  their state lives beside environment state. The sweep counts every stored
  coordinator workspace and conversation as an owner; without that it would
  have deleted live coordinator state.
- **Merged-PR branches.** A merged PR alone does not make the branch
  disposable when `refs/remotes/origin/<branch>` is known and the local tip is
  ahead of it: those commits were made after the merge and exist only locally.
- **No second ownership probe.** Deletion asserts container ownership before
  the tombstone, so its own container step skips `assertDockerContainerOwned`.
  The reconciler always probes.
- **Workflow results** are reached through a narrow
  `context.deleteWorkflowResultsByEnvironment` hook. The main backend context
  does not carry `workflowResults`, and adding it would change unrelated
  commands.
- **Preview definitions.** Registry startup seeds a reconcile for every
  environment named by a stored definition as well as every live environment;
  reconciling a missing environment already drops its definitions.
- **Web annotations.** `WebAnnotationStorage.init()` accepts an
  `environmentExists` check from the host. A lookup that fails counts as
  existing.
- **Retry scheduling.** Startup runs the bridge-state sweep and then a
  background reconcile. Each successful deletion schedules another. Deferred
  entries re-arm an unreferenced timer for the earliest due retry (backoff
  1 minute doubling to 6 hours).

Code: `environment-state-paths.ts`, `environment-cleanup-ledger.ts`,
`environment-cleanup.ts`, `environment-cleanup-reconciler.ts`, plus the
deletion changes in `commands-servers.ts` and `commands-terminal.ts` and the
`terminate()` method in `pty.ts`.

## Related, separate

Test fixtures named `scan-caches-*` have been created in the real workspaces
root, pointing at `/tmp/ork-electron-git-*` repositories. This is a
test-isolation defect, not a deletion leftover. Track it separately.
