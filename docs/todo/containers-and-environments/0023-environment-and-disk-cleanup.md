# Environment and disk cleanup

Checked against `main` at `31d0fb06` (2026-10-17).

Deleting an environment, the startup reconciler and the pre-ledger sweeps
remove only state Orkestrator can prove it owns, and dev tooling and tests
must not grow disk without bound. The code shipped in #856 (deletion ledger,
branch policy, reconciler) and #879 (dev profile pruning, test isolation,
pre-ledger sweeps, `disk:report`). The real-stack evidence was recorded on
2026-10-17 (below). What remains is a few test temporary directories that still
leak, and a way to see cleanup that has stopped retrying.

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
  - `sweepOrphanedDesignCanvases`: design canvases. It loads the owner set
    only when some canvas has an owner, so a fresh data directory whose
    environment store was never written no longer logs a refused sweep.
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
- Evidence: unit suites; the real-stack specs "deletion during local setup
  clears worktree, bridge state, branch and ledger" (run by
  `mise run test:agent:browser:isolated`) and "Docker fixture deletion removes
  only the target container, volumes, network and ledger entry" (run by
  `mise run test:agent:docker`), both in
  `e2e/agent-testing/browser-gateway.spec.ts`; live C19
  (`apps/backend/tests/container-live-replacement.test.ts`) on Linux Engine
  and Docker Desktop; and the seeded sweep pass below.

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
3. Remove a profile's `safeStorage` Keychain item when `dev:reset` removes the
   profile. Electron stores the key as the generic password
   `<electronTitle> Safe Storage` in the login Keychain, and nothing deletes
   it. On 2026-10-17 the run host had 292 such items. Agent-test profiles on
   macOS no longer create one (`use-mock-keychain`, see
   [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md) evidence log), but
   `development` profiles still do. Delete only the reset profile's own item
   (`security delete-generic-password -s "<title> Safe Storage"`).

### Qualification

None outstanding. The results are below.

## Qualification results (2026-10-17)

Run on `todo-env-cleanup-realstack` at `main` `31d0fb06` plus this change,
on macOS 27.0 arm64 (Apple Silicon) with Docker Desktop 4.93.0 (Engine 29.8.1)
and Bun 1.4.3. Each run used the isolated profile `qa-envclean-05b87b2c`, which
was stopped and reset afterwards.

| Scenario | Result |
| --- | --- |
| Deletion during local setup, as shipped | Pass, not skipped. But the backend logged `no setup commands found`: the fixture has no `orkestrator-ai.json`, so no setup was running when deletion ran. |
| Deletion during local setup, with a running setup (spec extended, see below) | Pass (5.5–6.0 s, four runs). `pgrep` found the setup shell before deletion; its PTY exited 137 on deletion, the worktree path stayed absent 1.5 s later, and no setup process survived. |
| Negative control: `terminateTerminalSessionsForEnvironment` stubbed out | Fail, as intended. The surviving setup re-created the worktree path. A relative-path loop had passed this control because it cannot re-create a removed cwd; the spec now writes by absolute path, as turbo does. |
| One-shot `mise run test:agent:browser:isolated` (profile `qa-browser-8311cc1a-7e5`) | The deletion spec passed, not skipped. Suite: 25 passed, 15 opt-in skips (the Docker spec among them), 1 failed. The failure was the known narrow host-picker flake [0224](../../tests/flaky-tests/0224-host-picker-narrow-tools-popover.md), which failed once and passed twice when run alone. |
| Seeded pre-ledger sweeps, restart without `--fixture` | Pass. Logged and observed: stray workspaces removed 1 (only a nested `.turbo/turbo-build.log`) and kept 1 (also holds `notes.txt`, logged once), a fresh stray kept silently; orphan branches deleted 2 (one merged into `main`, one with no new commits), kept 1 (unmerged commit), the non-scheme branch untouched; temp files removed 1 (`qa-store.json.4999999.tmp`, dead PID, 2 h old), kept PID 1, fresh and non-PID names; orphan bridge state directories removed 1, a fresh one kept. |
| Seeded pre-ledger sweeps, an earlier restart with `--fixture` | Not valid: `deleted 0, kept 2`. `dev:test --fixture` deletes and re-creates the fixture repository (`apps/desktop/scripts/dev/fixture.ts`) after Electron is ready, concurrently with the backend's background startup sweep, which counted the vanishing branches as kept. |
| Isolation | The backend held only the profile's `orkestrator.sqlite`. The main workspaces root, the main data directory's temp files and the other profiles were unchanged. |
| Live C19 on Docker Desktop (`dev-b4d6266ccb00`, built after #1041) | Pass: 1 pass, 0 fail. The other tests in the file were filtered out with `-t C19`. |
| Real-stack containerized deletion on Docker Desktop (new spec) | Pass. Container, volumes and network existed before `delete_environment`; none remained after, and the ledger had no entry. The fixture container's resources were untouched. |
| Startup on a fresh profile | Before this change: `Orphaned design canvas sweep failed: Error`, because the environment store did not exist yet. After it: no warning. |

To repeat the sweep pass:

1. Start a profile with `--fixture` once, then stop it.
2. Seed the candidates and backdate them by at least an hour. Use
   `find <dir> -depth -exec touch -h -t <time> {} +`, because creating a file
   resets its directory's mtime.
3. The first start already recorded a branch sweep for the fixture project,
   and the next pass waits 24 hours. Rewrite its time in the
   `environment-cleanup-sweeps` store with
   `bun e2e/agent-testing/backend-store.ts <dataDir> environment-cleanup-sweeps.json write`.
4. Restart **without** `--fixture`.

Decisions taken in this run:

- The deletion spec now starts its environment from a dangling commit that
  adds a looping `setupLocal`, passed as `delegationBaseCommit`. The shared
  fixture branch is untouched, and `finally` kills any survivor by a unique
  marker.
- Container deletion is qualified by a new real-stack spec gated on
  `ORKESTRATOR_AGENT_TEST_DOCKER`, alongside live C19. That spec exercises the
  real `delete_environment` path, where C19 uses an in-memory context.
- The sweep pass was run by hand rather than as a spec. It needs a backend
  restart and backdated mtimes, which the browser suite cannot do inside one
  profile.

### Review follow-up (2026-10-17)

On branch `todo/env-cleanup-realstack-qualification` (base `160610af` plus
the review fixes), the Docker deletion spec now captures the seeded fixture's
container, volume and network identities before creating the deletion target.
After deletion it checks those same resources remain, the fixture still maps
to the same container, and Docker reports that container running. The target's
resource-removal and settled-ledger assertions remain in place.

The credential-free profile `qa-cleanup-review-1017` was started with
`mise run dev:test --profile qa-cleanup-review-1017 --fixture --fixture-environments local,container --no-agent-credentials --agent-platforms codex`.
It built this worktree's image, `orkestrator-v2:dev-2a06b889134b`, on Docker
Desktop Engine 29.8.1 with Bun 1.4.3.

| Logged command | Result |
| --- | --- |
| `ORKESTRATOR_AGENT_TEST_PROFILE=qa-cleanup-review-1017 ORKESTRATOR_AGENT_TEST_RUN_ID=qa-cleanup-review-1017 mise run test:logged -- --name review-agent-docker -- mise run test:agent:docker` | 6 passed, 0 skipped, 0 failed (59.7 s). Includes deletion with fixture-preservation assertions, foreign-owner rejection, Chromium launch for both users, inactive-environment rebuild and desktop/narrow settings rehydration. |
| `ORKESTRATOR_AGENT_TEST_PROFILE=qa-cleanup-review-1017 ORKESTRATOR_AGENT_TEST_RUN_ID=qa-cleanup-review-1017-local mise run test:logged -- --name review-local-deletion -- mise run test:agent:browser -- e2e/agent-testing/browser-gateway.spec.ts --grep 'deletion during local setup'` | 1 passed, 0 skipped, 0 failed (7.1 s). |

Sanitized browser reports are under
`output/agent-testing/qa-cleanup-review-1017/browser/results.json` and
`output/agent-testing/qa-cleanup-review-1017-local/browser/results.json`
(ignored artifacts). The profile was stopped and reset after validation.
The focused flaky-test register test passed after restoring case 0265's ID
and open-status metadata to match `origin/main`; format, lint and repository
typechecks passed as well.

`mise run test:logged -- --name review-tests -- mise run test` (with the
testing guide's GNU-tool PATH) exited 1 after 840.1 seconds. Root, bridges,
protocol and every workspace package except backend passed. Backend reported
8612 passed, 41 skipped, eight timeouts and one late SQLite error. The two
unchanged owning files then passed separately with `--parallel=1`: lifecycle
in 18.9 seconds and coordinator in 20.2 seconds. The existing flaky-test cases
[0194](../../tests/flaky-tests/0194-environment-lifecycle-deletion-aggregate-timeout.md),
[0226](../../tests/flaky-tests/0226-deletion-reap-failure-aggregate-timeout.md) and
[0165](../../tests/flaky-tests/0165-coordinator-bound-discard-timeout.md) record
the exact commands, failures, worker counts and compressed evidence. This
aggregate run is not a clean full-suite pass.

Electron, CLI and iOS scenario suites were omitted because this follow-up
changes test assertions and documentation only.

## Constraints and rationale

The full rules are in
[environment-deletion.md](../../architecture/environment-deletion.md). Any change
here must keep these invariants:

- Delete only what the ledger names, or what is provable from a name: bridge
  state directories are `<hash>` of an environment or coordinator runtime id,
  and branch namespaces come from `parseEnvironmentBranchNamespace`.
- The ledger entry is written immediately after the deletion tombstone and
  before any destructive step. The environment record is still removed on
  time; what failed stays in the ledger for the reconciler.
- Every ledger path must resolve inside the data directory or the recorded
  worktree root, and every directory removal goes through
  `removeConfinedDirectory`, so a symlink cannot redirect it.
- Unmerged branches are always kept, and no setting deletes them.
- Sweeps without a ledger skip anything modified in the last hour, abort when
  the owner set cannot be listed completely, and run under lifecycle
  admission.
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
- Should the stray workspace directory sweep also cover the folders
  environments were created in (`worktreeBaseDir`, chosen per environment
  or in Settings > Disk usage)? Today it lists only the backend's worktree
  root (`getWorktreeBaseDir`), so a stray directory in a user-chosen folder
  is never swept.

## Needs verification

- Which writers still produce `<name>.json.<pid>.tmp` in the data directory
  since #969 moved most stores to SQLite. The temp-file sweep may now only
  clear pre-SQLite leftovers.

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
  (Desktop runs), [0021-container-rebuild-state-preservation.md](0021-container-rebuild-state-preservation.md)
  (recovery copies and volumes the ledger removes),
  [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md),
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).
- [Environment deletion](../../architecture/environment-deletion.md): scope,
  deletion order, ledger semantics, branch policy, reconciler backoff and
  sweep ownership.
- [Disk usage](../../development/disk-usage.md) for the operator view.

## Replaces

- `docs/plans/environment-deletion-cleanup.md` (step 08 real-stack
  verification and the failing-cleanup diagnostics follow-up are above; the
  design moved to `architecture/environment-deletion.md`)
- `docs/plans/orphaned-disk-state-cleanup.md` (all: the implementation notes
  are in `architecture/environment-deletion.md`, the open real-stack pass and
  test-prefix follow-ups are above, and the machine measurements are
  historical)
- `docs/improvements/containers/plan/07-recovery-deletion-and-cleanup-ux.md`
  (deletion ordering and the ledger's volume and network steps)
