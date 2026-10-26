# Environment and disk cleanup

Checked against `main` at `31d0fb06` (2026-10-17); items 1–3 worked on
2026-10-26 against `main` at `93018933`.

Deleting an environment, the startup reconciler and the pre-ledger sweeps
remove only state Orkestrator can prove it owns, and dev tooling and tests
must not grow disk without bound. The code shipped in #856 (deletion ledger,
branch policy, reconciler) and #879 (dev profile pruning, test isolation,
pre-ledger sweeps, `disk:report`). The real-stack evidence was recorded on
2026-10-17 (below). On 2026-10-26 the test temporary-directory leaks were fixed,
`disk:report` gained a row for cleanup that has stopped retrying, and
`dev:reset` now removes a profile's macOS Keychain item. What remains is a live
macOS run of that last change.

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
  6 hours. After `MAX_ENVIRONMENT_CLEANUP_ATTEMPTS` (8, now defined with
  `isEnvironmentCleanupExhausted` in `environment-cleanup-ledger.ts`) an entry
  is kept for inspection and logged once per process with `console.warn`.
  Since 2026-10-26 `disk:report` shows it (`environment cleanup ledger` row);
  the UI and recurring diagnostics do not.
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
  `pruneProfiles`, `removeProfileKeychainItem`, the build-cache warning at
  `BUILD_CACHE_WARNING_BYTES`, 25 GB), the `dev:prune` task and orphan pruning
  at `dev`/`dev:test` start.
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

1. ~~Fix the remaining test temporary-directory leaks~~ Done 2026-10-26, all
   at source rather than through `tests/temp-sweep.ts`:
   - `pi-http-mcp-` and `pi-http-rotate-` in `bridges/pi-bridge/src/http.test.ts`:
     created through a file-level `ownedTempDirectory`, removed in `afterAll`
     after the server shuts down (the MCP agent directory outlives the test
     body).
   - `ork-journal-gc-` in `bridges/codex-bridge/src/sessions/dispatch-journal.test.ts`:
     created through `journalHome`, which registers it in `temporaryDirs`.
   - `ork-watch-` in `apps/backend/tests/worktree-watcher.test.ts`: removed by
     a cleanup registered before the watcher's, so it runs after the close.
   - `ork-gitpaths-` in the same file (found by this pass, not listed before):
     its cleanup was `void fs.rm(...)` in the file's last test, so the process
     could exit first. The file's `afterEach` now awaits each cleanup.
   - `cursor-bridge-sdk-test-<pid>` in `bridges/cursor-bridge/src/agent-session.test.ts`:
     `afterAll` now removes `bridgeStateRoot`.
   - `recurring-live-ab-cli-` (found by the full-suite sweep): every CLI
     runner in `scripts/recurring-live-ab.ts` made a config directory nothing
     removed, both in `tests/unit/recurring-live-ab-runner.test.ts` and in
     real A/B runs. `runArm` now creates one lazily, passes it to both runners
     and removes it after the profile cleanup; a new test checks it.

   Evidence: the four files run with `TMPDIR` set to an empty directory left
   it empty; with the test changes reverted the same runs left exactly
   `cursor-bridge-sdk-test-*`, `ork-gitpaths-*`, `ork-journal-gc-*`,
   `ork-watch-*`, `pi-http-mcp-*` and `pi-http-rotate-*`; the A/B runner file
   left two `recurring-live-ab-cli-*` before its fix and none after. The
   full-suite sweep is recorded under
   [Full-suite temp sweep](#full-suite-temp-sweep-2026-10-26).
   `ork-preview-*` and `orkestrator-activity-boot-` are removed on the
   normal path. `ork-runtime-` and `orkestrator-state-sync-` were believed to
   be, but the direct sweep below left several of each; they and every other
   leak that sweep found are in
   [0247](0247-test-temp-dir-leaks-from-full-sweep.md).
   `orkestrator-test-run.*` is kept for 7 days on purpose by
   `scripts/test-all.ts`, because it holds failure logs.
2. ~~Optional: surface permanently failing cleanup.~~ Done 2026-10-26 as a
   `disk:report` row (decision 2). `environment-cleanup-ledger.ts` now owns
   `MAX_ENVIRONMENT_CLEANUP_ATTEMPTS`, `isEnvironmentCleanupExhausted` and
   `parseEnvironmentCleanupLedger` (the reconciler imports the first two and
   re-exports the cap). `environmentCleanupLedgerRow` in
   `scripts/disk-report.ts` reads the store read-only and reports
   `<n> stopped retrying, <m> retrying`, then for stopped entries the pending
   step counts, up to three distinct redacted `lastError` values and up to
   three environment ids. Entries whose environment record still exists are
   skipped, as the reconciler skips them. Evidence: `tests/unit/disk-report.test.ts`
   seeds the real SQLite ledger through `EnvironmentCleanupLedger` (cap,
   cap + 1, cap − 1 and a live environment) and checks the row, the
   overflow text and that no path leaks into it, and runs the script itself
   against a seeded `HOME`/`XDG_CONFIG_HOME`; `environment-cleanup-ledger.test.ts`
   covers the predicate and parser. A real `mise run disk:report` on this
   Linux host (omarchy-hp) against a seeded throwaway data directory printed
   `1 stopped retrying, 1 retrying (pending: worktree 1, branch 1; last errors: worktree: EACCES)`.
3. Remove a profile's `safeStorage` Keychain item when `dev:reset` removes the
   profile. **Code done 2026-10-26; live macOS run owed.** Electron stores the
   key as the generic password `<app name> Safe Storage`, account
   `<app name>` (`ElectronBrowserMainParts::PostCreateMainMessageLoop`), and
   a profile's app name is its `electronTitle`. On 2026-10-17 the run host had
   292 such items. Agent-test profiles on macOS no longer create one
   (`use-mock-keychain`, see
   [0042-service-preview-rollout.md](../previews-and-annotations/0042-service-preview-rollout.md) evidence log), but
   `development` profiles still do.

   Built: `removeProfileKeychainItem` (`apps/desktop/scripts/dev/profile-cleanup.ts`)
   runs `security delete-generic-password -s "<title> Safe Storage" -a "<title>"`
   until it exits 44 (not found), at most 8 times, each call bounded to 15 s
   so a locked Keychain's unlock dialog cannot stall unattended start-up
   pruning. `removeProfile` calls it
   only after the profile state is removed, so `dev:reset`, `dev:prune` and
   start-up pruning all use it, and a failed reset keeps the key. It runs only
   on macOS, and only when the profile's `electronTitle` equals
   `runtimeProfileElectronTitle(id)` (new in `electron/runtime-profile.ts`), so
   an edited `profile.json` can never delete the production app's key. Any
   other `security` failure becomes a warning (`dev:reset` prints it,
   `dev:prune` appends it to the outcome) and does not fail the removal. Unit
   tests in `profile-cleanup.test.ts` cover deletion of every copy and no
   other item, ordering after state removal, no call when removal fails, no
   call off macOS, refusal of a foreign title, a locked Keychain, and the
   prune outcome. The suite's command runner now records `security` calls, so
   no test can reach a host Keychain.

   Still owed (needs a macOS host; omarchy-hp is Linux): start a development
   profile, for example
   `mise run dev:test --profile qa-keychain-0023 --fixture --no-agent-credentials`
   (main awaits `safeStorage` before its first window, which creates the
   item; sign in with `mise run dev:login` if it does not), stop it with
   `mise run dev:stop --profile qa-keychain-0023`, and confirm `security find-generic-password -s "Orkestrator AI — DEV [qa-keychain-0023] Safe Storage"`
   finds it. Then run `mise run dev:reset --profile qa-keychain-0023`, check
   the output says `Removed 1 login Keychain item(s).`, that the same
   `find-generic-password` now exits 44, and that
   `security find-generic-password -s "Orkestrator AI Safe Storage"` (the
   production item, if present) is unchanged. Record the macOS version,
   Electron version and output here.

### Qualification

Only the macOS Keychain run in item 3. The 2026-10-17 results are below.

## Full-suite temp sweep (2026-10-26)

`TMPDIR=/tmp/ork0023-full-tmp mise run test:logged -- --name full-test -- mise run test`
on omarchy-hp (Linux x86_64) at `d0de935d`, with the private directory empty
beforehand. Afterwards it held only:

| Left behind | Verdict |
| --- | --- |
| `orkestrator-test-run.*` | Intended: failure logs kept 7 days by `scripts/test-all.ts`. |
| `orkestrator-test-scheduler-v1-<uid>`, `orkestrator-test-timings.*`, `playwright-transform-cache-<uid>`, `jiti` | Intended: the test scheduler's state and timing history, and tool caches, reused by the next run. |
| `recurring-live-ab-cli-*` (2) | Leak, fixed in item 1. |
| `policy-cli-*` | Only when the live OpenCode research test times out: the test is abandoned before `withPolicyCliFixture`'s `finally` runs. Recorded in flake [0785](../../tests/flaky-tests/coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md) rather than fixed here, since the cause is the hang. |

That sweep covers the root and agent-support group only. Turbo runs the
workspace and bridge groups in strict environment mode and does not pass
`TMPDIR` through, so those tests wrote to `/tmp` (an aggregate failure in
`commands-project-creation.test.ts` named `/tmp/ork-project-create-*`, which
that file creates through `os.tmpdir()`). The four workspace and bridge files
in item 1 were swept one by one instead. A complete sweep of those groups
would run each package's own script outside Turbo with a private `TMPDIR`,
for example `TMPDIR=<empty dir> bun run --cwd apps/backend test:workspace`,
and the same for each bridge's `test:bridge`. The suite itself did not pass;
its failures are in flake
[1010](../../tests/flaky-tests/aggregate-validation-runs/1010-environment-disk-cleanup-0023-validation.md).

That direct sweep was then run: all five bridges' `test:bridge` and the
backend's `test:workspace` with an empty private `TMPDIR`. The bridges
passed; the backend had 11,721 passed, 142 skipped and 2 failed (flake 0785,
and a test that reads the host's `XDG_STATE_HOME`). It left about twenty
directories under fifteen test-owned prefixes. They are new work and are
inventoried, with owners, in
[0247](0247-test-temp-dir-leaks-from-full-sweep.md).

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
| One-shot `mise run test:agent:browser:isolated` (profile `qa-browser-8311cc1a-7e5`) | The deletion spec passed, not skipped. Suite: 25 passed, 15 opt-in skips (the Docker spec among them), 1 failed. The failure was the known narrow host-picker flake [0224](../../tests/flaky-tests/previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md), which failed once and passed twice when run alone. |
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
[0194](../../tests/flaky-tests/environments-and-containers/0194-environment-lifecycle-deletion-aggregate-timeout.md),
[0226](../../tests/flaky-tests/environments-and-containers/0226-deletion-reap-failure-aggregate-timeout.md) and
[0165](../../tests/flaky-tests/coordinator-and-multi-review/0165-coordinator-bound-discard-timeout.md) record
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

- ~~Which writers still produce `<name>.json.<pid>.tmp` in the data directory
  since #969 moved most stores to SQLite.~~ Checked 2026-10-26 against
  `93018933`: no backend store writes one at the top of the data directory any
  more (`github-ranges-cache.ts` writes `github-ranges.txt.<pid>.tmp`, which
  the pattern does not match, and the others write into subdirectories). The
  desktop main process still does, because Electron's `userData` is the same
  directory: `preview-partitions-pending.json` (`preview-partition-retention.ts`),
  `preview-ports.json` (`preview-port-hints.ts`), and `agent-platforms.json`
  and `config.json` (`agent-platform-selection.ts`). So
  `sweepAbandonedTempFiles` still covers live writers and stays.

## Assumptions and decisions

Decisions made on 2026-10-26 while working through the file.

1. **Fixing the leaks at source or through `tests/temp-sweep.ts` (item 1).**
   Options: (a) remove each directory in its own test file; (b) rename the
   prefixes to `<prefix><pid>-<random>` and let `sweepStaleTempDirs` collect
   them at the next run. Chose (a). Pros: nothing is left even for a run that
   is never followed by another; each fix is a line or two in the owning
   file; no sweep list to maintain. Cons: a test that crashes mid-run still
   leaks, which (b) would eventually catch; no existing file used (b) for
   these prefixes, so there was nothing to reuse.
2. **Where to surface permanently failing cleanup (item 2).** Options: (a) a
   `disk:report` row; (b) a section in the recurring-work diagnostics
   (`get_recurring_work_diagnostics`, `/api/metrics`); (c) a UI notice in
   Settings > Disk usage, needing a new backend command and renderer work.
   Chose (a). Pros: `disk:report` is already the operator's view of what
   cleanup left behind, is read-only and can name environment ids and the
   redacted error; it reads the store with the ledger's own parser and
   predicate, so the two cannot drift. Cons: a user who never runs
   `disk:report` still sees only the log line. (b) was rejected because those
   diagnostics are documented as content-free and I/O-free (they would need a
   cached count published by the reconciler and could carry no ids or
   errors); (c) is a new feature for a rare state (Low file), better taken up
   with the open question on retrying exhausted entries.
3. **Counting entries whose environment still exists (item 2).** Options:
   count every entry at the cap, or skip those whose environment record still
   exists. Chose to skip them, matching the reconciler, which leaves those to
   interrupted-deletion recovery. Pros: the row means exactly "the reconciler
   gave up". Cons: an exhausted entry for a live environment is not shown
   until the environment is deleted.
4. **Which removals delete the Keychain item (item 3).** Options: only
   `dev:reset`, or every profile removal (`removeProfile`, which `dev:reset`,
   `dev:prune` and start-up orphan pruning share). Chose every removal. Pros:
   a pruned profile leaves the same item a reset one does; one code path.
   Cons: pruning can now touch the login Keychain, bounded to the pruned
   profile's own item.
5. **How narrowly to match the item (item 3).** Options: (a) by service only
   (`-s`); (b) by service and account (`-s` and `-a`); (c) also check the
   profile's title against the one `dev:test` derives from its id. Chose (b)
   and (c). Electron sets both names from the app name, so (b) still matches
   every item Electron created, and (c) means an edited `profile.json` naming
   `Orkestrator AI` cannot delete the production key. Cons: a profile created
   under an older title format keeps its item (none is known).
6. **When to delete it, and what a failure does (item 3).** Chose: after the
   profile state is removed, and a failure is a warning, not an error. Pros:
   a reset that fails earlier keeps both the encrypted data and its key; a
   locked or denied Keychain does not make an otherwise complete reset look
   failed. Cons: a warning can be missed; the item then stays until removed
   in Keychain Access.
7. **Leaks the sweep found beyond item 1's list.** Options: fix them all
   here; or record them in a new file. Chose a new file,
   [0247](0247-test-temp-dir-leaks-from-full-sweep.md), as `docs/README.md`
   requires (an existing file takes no new todos). The one found in the
   root group's aggregate sweep (`recurring-live-ab-cli-*`) was fixed here
   because it was the only leak that sweep showed. Pros: item 1 stays the
   list it named; the fifteen backend and bridge prefixes each need their
   own owner check. Cons: the suite still leaks until 0247 is done.
8. **Linux secret stores (outside this file's scope).** On Linux Electron
   keeps the key in the Secret Service or KWallet when one is available.
   Whether development profiles leave items there was not checked: doing so
   means reading this host's keyring, which the run's rules leave alone.
   Recorded here only; open a new todo if a Linux run shows leftovers.

## Related

- [0019-container-platform-qualification.md](0019-container-platform-qualification.md)
  (Desktop runs), [container lifecycle](../../architecture/container-lifecycle.md#recovery-copies)
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
