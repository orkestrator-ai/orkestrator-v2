# Environment and disk cleanup

Checked against `main` at `2459b05c` (2026-10-15).

Deleting an environment, the startup reconciler and the pre-ledger sweeps
remove only state Orkestrator can prove it owns, and dev tooling and tests
must not grow disk without bound. The code shipped in #856 (deletion ledger,
branch policy, reconciler) and #879 (dev profile pruning, test isolation,
pre-ledger sweeps, `disk:report`). What remains is real-stack evidence, a few
test temporary directories that still leak, and a way to see cleanup that has
stopped retrying.

## Current state

- Deletion writes a ledger entry before any destructive step
  (`apps/backend/src/core/environment-cleanup-ledger.ts`). Since #969 the
  ledger is the SQLite store `environment-cleanup-ledger`, no longer
  `environment-cleanup-ledger.json`. The steps are `ENVIRONMENT_CLEANUP_STEPS`:
  `container`, `volumes`, `network`, `worktree`, `branch`, `state-dirs`. The
  step runners, including `cleanupEnvironmentBranch`, are in
  `environment-cleanup.ts`; per-environment state paths come from
  `environmentStateDirectories` (`environment-state-paths.ts`).
- `deleteEnvironment` (`commands-servers.ts`) awaits
  `terminateTerminalSessionsForEnvironment` (`commands-terminal.ts`, built on
  the PTY handle's `terminate()`) before removing the worktree, so a setup
  descendant cannot re-create it. Merge-triggered cleanup goes through
  `deleteEnvironmentTask` and inherits the same ledger.
- `reconcileEnvironmentCleanup` (`environment-cleanup-reconciler.ts`) retries
  pending steps through the environment lifecycle queue, with
  `environmentCleanupRetryDelayMs` backing off from 1 minute, doubling, to
  6 hours. After `MAX_ENVIRONMENT_CLEANUP_ATTEMPTS` (8) an entry is kept for
  inspection and logged once per process with `console.warn`. Nothing in the
  UI, diagnostics or `disk:report` shows it.
- Sweeps for state whose owner is provable without a ledger:
  - `sweepOrphanedEnvironmentState`: bridge state directories.
  - `sweepOrphanedDesignCanvases`: design canvases.
  - `WebAnnotationStorage.init({ environmentExists })`: web annotation
    stores.
  - `sweepPreLedgerDiskState` runs `sweepStrayWorkspaceDirectories`,
    `sweepOrphanedEnvironmentBranches` and `sweepAbandonedTempFiles`.

  Per-project branch sweep times and cursors live in the store
  `environment-cleanup-sweeps`. `runStartupEnvironmentCleanup` starts it all.
- Dev tooling: `apps/desktop/scripts/dev/profile-cleanup.ts` (`removeProfile`,
  `pruneProfiles`, the build-cache warning at `BUILD_CACHE_WARNING_BYTES`,
  25 GB), the `dev:prune` task and orphan pruning at `dev`/`dev:test` start.
- Tests: `tests/temp-sweep.ts` (`createOwnedTempDir`, `sweepStaleTempDirs`)
  names directories `<prefix><pid>-<random>`. It is used by
  `tests/isolate-git-config.ts`, `tests/isolate-worktree-dir.ts` and
  `apps/backend/tests/standalone.test.ts`. `apps/backend/tests/command-fixtures.ts`
  gives each context its own `worktreeDir`, and points `DOCKER_HOST` at a
  missing socket unless `RUN_LIVE_DOCKER_TESTS=1`.
- `scripts/disk-report.ts` (`mise run disk:report`, `--json`,
  `--fix legacy-turbo`) is read-only and uses the same predicates as the
  pruners.
- Evidence so far: unit suites, the real-stack spec "deletion during local
  setup clears worktree, bridge state, branch and ledger" in
  `e2e/agent-testing/browser-gateway.spec.ts` (run by
  `mise run test:agent:browser:isolated`), and live C19
  (`apps/backend/tests/container-live-replacement.test.ts`) on Linux Engine
  only.

## Outstanding work

### Code

1. Fix the remaining test temporary-directory leaks, at source or by opting
   the prefix into `tests/temp-sweep.ts`:
   - `pi-http-mcp-` and `pi-http-rotate-` in `bridges/pi-bridge/src/http.test.ts`:
     an inline `mkdtemp` passed as `agentDir` and never removed.
   - `ork-journal-gc-` in `bridges/codex-bridge/src/sessions/dispatch-journal.test.ts`
     ("old terminal records are dropped"): created with `mkdtempSync` but
     not added to the file's `temporaryDirs`, so its `afterEach` misses it.
   - `ork-watch-` in `apps/backend/tests/worktree-watcher.test.ts` ("observes
     a real file write"): the watcher is closed, the directory is not removed.
   - `cursor-bridge-sdk-test-<pid>` (`bridgeStateRoot`) in
     `bridges/cursor-bridge/src/agent-session.test.ts`: `afterAll` restores
     the overrides but leaves the directory.

   These are already removed on the normal path: `ork-runtime-`,
   `ork-preview-*`, `orkestrator-state-sync-` and `orkestrator-activity-boot-`.
   `orkestrator-test-run.*` is kept for 7 days on purpose by
   `scripts/test-all.ts`, because it holds failure logs.
2. Optional: surface permanently failing cleanup. Add a diagnostics entry or a
   `disk:report` row for ledger entries at the attempt cap (count, pending
   steps, redacted `lastError`), using the ledger's own predicates.

### Qualification

- A recorded run of the deletion spec on current `main` that actually ran,
  not skipped.
- A real-stack pass of the pre-ledger sweeps in an isolated `dev:test`
  profile. Seed the following, restart the backend, then check what was
  removed against what was reported:
  - a stray workspace directory holding only `.turbo/turbo-*.log` (removed)
    and one holding any other file (kept, logged);
  - merged and unmerged orphan branches in the environment naming scheme
    (merged deleted, unmerged kept and counted);
  - an abandoned `<store>.json.<pid>.tmp` in the data directory with a dead
    PID, older than an hour (removed).

  Backdate the seeded mtimes: anything modified in the last hour is skipped.
- Container deletion through the ledger on Docker Desktop, covering the
  `container`, `volumes` and `network` steps. See
  [container-platform-qualification.md](container-platform-qualification.md).

## Constraints and rationale

- Delete only what the ledger names, or what is provable from a name: bridge
  state directories are `<hash>` of an environment id, and branch namespaces
  come from `parseEnvironmentBranchNamespace`.
- The ledger entry is written immediately after the deletion tombstone and
  before any destructive step. The environment record is still removed on
  time; what failed stays in the ledger for the reconciler.
- Every ledger path must resolve inside the data directory or the worktree
  base, and every directory removal goes through `removeConfinedDirectory`,
  so a symlink cannot redirect it.
- Coordinator runtime ids count as owners of bridge state; coordinator
  conversations run the same bridges beside environment state.
- Branch policy. Unmerged branches are always kept, and no setting deletes
  them. A branch is disposable only when one of these holds:
  - its PR merged and the local tip is contained in `refs/remotes/origin/<branch>`
    (a merged PR does not make a branch disposable when the local tip is ahead);
  - the tip is contained in a merge target such as `origin/HEAD` or the
    default branch;
  - it has no commits beyond `createdFromCommit`.

  A branch checked out in any worktree is never deleted. `git branch -D`
  runs only after a check passes; `git branch -d` is not a substitute,
  because it judges against the upstream or the checkout's `HEAD` and
  rejects squash merges.
- Pre-ledger sweeps have no ledger, so their rules are stricter:
  - Stray workspace directories directly under `getWorktreeBaseDir()`. A
    directory is removed only when:
    - no live or deleting environment and no ledger entry references it;
    - it is not a project checkout or a registered worktree of any known
      project;
    - it holds nothing but directories and `**/.turbo/turbo-*.log`.

    The walk never follows symlinks, and the newest mtime anywhere in the
    tree counts. A walk over 10,000 entries, or one that cannot be read,
    counts as content. A failed `git worktree list` for any project abandons
    the pass. The count of unowned directories kept because they hold files
    is logged only when it changes.
  - Orphaned environment branches. Names follow `<slug>-<ns>[-r<N>][-<n>]`:
    revision 0 has no `-r`, and allocation can add up to two collision
    suffixes. `parseEnvironmentBranchNamespace` is the single definition,
    shared with `disk:report`. Protected branches:
    - namespaces of live and deleting environments and of ledger entries;
    - recorded `branch` and `delegationBaseBranch` names;
    - branches checked out in any worktree;
    - the configured default branch and the `origin/HEAD` target.

    A pre-ledger branch has no PR state, so only the merge-target test and
    "no commits beyond its reflog `Created from` entry" can pass. Deletion
    goes through `cleanupEnvironmentBranch`. Each project is swept at most
    once a day (`ORPHANED_BRANCH_SWEEP_INTERVAL_MS`), at most 500 candidates
    per pass, with a cursor for the rest.
  - Temp files: only names of the shape `<name>.json.<pid>.tmp` in the data
    directory, when that PID is not running. Other shapes, such as
    `.coordinators.json.<uuid>.tmp`, are left alone.
  - Anything modified in the last hour is skipped
    (`ORPHANED_STATE_MIN_AGE_MS`), which covers a creation in progress.
  - The sweeps run as one lifecycle operation under the reserved queue key
    `orphaned-disk-state-sweep`, so they get shutdown admission and draining.
    Creation cannot collide with them: it never reuses an existing path or
    branch name, and each new environment gets a fresh namespace. Each sweep
    fails alone and logs once per process.
- Never prune the Docker build cache, images or other tools' state (Claude
  Code worktrees and transcripts, Codex sessions, mise installs)
  automatically. Report them instead.
- Test cleanup: Bun does not deliver `exit` to handlers registered in a test
  preload, and under `--parallel` re-runs the preload per file. A preload-level
  `afterAll` is the primary cleanup and `exit` handlers are only a fallback.
  `tests/temp-sweep.ts` removes a directory only when its PID is dead and it
  is past the age limit.

## Open questions

- Should a permanently failing ledger entry block re-creating an environment
  in the same namespace? Today namespaces are fresh per environment, so it
  never collides.
- Should an entry at the attempt cap ever be retried again, for example after
  a backend upgrade or on an explicit user action?

## Needs verification

- Which writers still produce `<name>.json.<pid>.tmp` in the data directory
  since #969 moved most stores to SQLite. The temp-file sweep may now only
  clear pre-SQLite leftovers.

## Related

- [container-platform-qualification.md](container-platform-qualification.md)
  (Desktop runs), [container-rebuild-state-preservation.md](container-rebuild-state-preservation.md)
  (recovery copies and volumes the ledger removes),
  [test-suite-and-ci-health.md](test-suite-and-ci-health.md),
  [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md).
- [Environment deletion design](../plans/environment-deletion-cleanup.md):
  scope, ledger semantics, branch policy and reconciler backoff. Its "Docker"
  section and JSON ledger path are superseded: the ledger has `volumes` and
  `network` steps and records retained containers (#877), and it is a SQLite
  store (#969).
- [Disk usage](../development/disk-usage.md) for the operator view.

## Replaces

- `docs/plans/environment-deletion-cleanup.md` (step 08 real-stack
  verification and the failing-cleanup diagnostics follow-up; the design
  stays in place)
- `docs/plans/orphaned-disk-state-cleanup.md` (all: the implementation notes
  are carried into "Constraints and rationale", the open real-stack pass and
  test-prefix follow-ups are above, and the machine measurements are
  historical)
- `docs/improvements/containers/plan/07-recovery-deletion-and-cleanup-ux.md`
  (deletion ordering and the ledger's volume and network steps)
