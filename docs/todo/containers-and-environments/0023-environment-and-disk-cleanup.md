# Environment and disk cleanup

Checked against `main` at `31d0fb06` (2026-10-17); items 1–3 worked on
2026-10-26 against `main` at `93018933`; tasks 4–6 decided and built on
2026-11-01 against `main` at `93b99bfb`.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Test temp-dir leaks (Code 1)**: fix the listed leaks at source. Status: done (2026-10-26, `7809191f`); the newly found leaks moved to [0247](0247-test-temp-dir-leaks-from-full-sweep.md).
2. **Surface permanently failing cleanup (Code 2)**: a `disk:report` row for ledger entries that stopped retrying. Status: done.
3. **Keychain item removed by `dev:reset` (Code 3)**: the code is done; the live macOS run is owed. Status: blocked (needs a macOS host).
4. **Failing entry and namespace reuse (open question)**: should an exhausted ledger entry block re-creating an environment in the same namespace? Status: done (2026-11-01): no guard; the invariant is documented and pinned by a test (decision 9).
5. **Retrying exhausted entries (open question)**: should an entry at the attempt cap ever be retried? Status: done (2026-11-01): one more cycle per backend version that never attempted it (decision 10).
6. **Stray sweep of user-chosen folders (open question)**: should the stray-workspace sweep cover `worktreeBaseDir` folders? Status: done (2026-11-01): yes, but there only for directories named by Orkestrator's worktree scheme (decisions 11–13).

The folder index row now says what remains: task 3's macOS run.

### 1. Test temp-dir leaks

**Problem.** Tests left temporary directories behind on every run.

**Context.** The fixes were made at source (decision 1). The full sweep then found more leaks, which went to 0247, because an existing file takes no new todos.

**Investigation.** Done in `7809191f` (#1299). The remaining leaks are 0247's.

**Decisions.** None: the item is done, and its follow-up work lives in 0247.

### 2. Surface permanently failing cleanup

**Problem.** A ledger entry that stopped retrying was visible only in a single `console.warn`.

**Context.** Decision 2 chose a `disk:report` row over diagnostics or a UI notice.

**Investigation.** All present at HEAD: `MAX_ENVIRONMENT_CLEANUP_ATTEMPTS = 8` (`apps/backend/src/core/environment-cleanup-ledger.ts:77`), `isEnvironmentCleanupExhausted` (`:83-87`), its use in the reconciler (`environment-cleanup-reconciler.ts:92-96`, `:129`) and `environmentCleanupLedgerRow` (`scripts/disk-report.ts:186`).

**Decisions.** None: done; the follow-on choices are tasks 4 and 5.

### 3. Keychain item removed by `dev:reset`

**Problem.** Each development profile leaves a `<title> Safe Storage` item in the macOS login Keychain, and the run host had 292 of them. The new removal code has never run against a real Keychain.

**Context.** The file gives the exact steps: a `dev:test` profile, then `dev:stop`, then `dev:reset`, then `security find-generic-password` checks. omarchy-hp is Linux.

**Investigation.** The code is in place: `removeProfileKeychainItem` (`apps/desktop/scripts/dev/profile-cleanup.ts:161-190`, `delete-generic-password` at `:186`), `keychainRoots` (`:229`, `:316`, `:371`, `:471`) and `runtimeProfileElectronTitle` (`apps/desktop/electron/runtime-profile.ts:178`). The file has not changed since `7809191f`.

**Decisions.**

- **Where to run it, and what counts as a pass?**
  - **Batch it into the macOS session in [0031](../cross-cutting/0031-live-provider-and-platform-qualification.md), using the file's steps. Pass when the dev item is found before the reset and exits 44 after it, and the production item is unchanged (recommended).**
    - Pros: one macOS session covers several gates; the pass criteria are already written.
    - Cons: waits for that session.
  - **Accept the unit tests and close the item.**
    - Pros: no macOS host needed.
    - Cons: the `security` exit codes and Electron's item naming would never be checked live, and the file rates release-sensitive Keychain behaviour.
- **Also check Linux secret stores (decision 8)?**
  - **No, leave them out of this file; open a new todo only if a Linux run shows leftovers (recommended).**
    - Pros: respects the rule against reading the host keyring; keeps this file's scope.
    - Cons: Linux development profiles may leak keyring items unnoticed.
  - **Check them on a disposable Linux account.**
    - Pros: closes the question.
    - Cons: new work, which needs a new file anyway.

### 4. Failing entry and namespace reuse

**Problem.** If a namespace were reused, a stuck ledger entry could remove state that belongs to its successor.

**Context.** The file says namespaces are fresh per environment.

**Investigation.** That is still true. `parseEnvironmentBranchNamespace` (`apps/backend/src/core/commands-agent-support.ts:218-224`) takes the 12-hex environment-id segment, and the `-rN` and numeric suffixes are retries and collisions within the same environment. No creation path reuses another environment's namespace.

Rechecked 2026-11-01 at `93b99bfb`: every production `addEnvironment` caller (`commands-registry-environments.ts`, `commands-registry-docker.ts`, `commands-environment-fork.ts`, `project-home-environment.ts`) gets its id from `randomUUID()` through `createEnvironment` or `createRecord`, and a move (`environment-move.ts`) keeps the same record. Independently of that, the steps act only on exact recorded names: `cleanupWorktree` skips a path a live environment claims, the branch must pass the branch policy, and state directories and the network follow the environment id, whose entry the reconciler skips while its record exists. Task 5 makes an exhausted entry act again after an upgrade, which is what made this worth pinning.

**Outcome.** No guard (the recommended option). The invariant and the defences above are now in [environment-deletion.md](../../architecture/environment-deletion.md#sweeps-without-a-ledger), and the reconciler test "an entry re-armed by an upgrade touches only what it names, not a namespace successor" builds a live successor that shares the deleted environment's namespace and was allocated its freed worktree path, re-arms the deleted environment's exhausted entry, and checks that the successor's worktree, branch (with no commits of its own, so the branch policy would delete it if named) and state survive while the entry's own state is removed. With `cleanupWorktree`'s live-path check removed, that test fails.

**Decisions.**

- **Add a guard?**
  - **No; record that namespaces are per environment id and revisit only if that changes (recommended).**
    - Pros: no code for a case that cannot happen today.
    - Cons: a future feature that reuses namespaces (for example a restore) has to remember this.
  - **Refuse creation when an exhausted entry names the namespace.**
    - Pros: safe against future reuse.
    - Cons: dead code today, and it would block a user with no remedy offered.

### 5. Retrying exhausted entries

**Problem.** An entry at the cap stays until someone acts, even after a backend upgrade has fixed its cause.

**Context.** Decision 2 rejected a UI notice for a rare state and deferred it to this question.

**Investigation.** The reconciler skips exhausted entries for good (`environment-cleanup-reconciler.ts:92-96`). The attempt counter starts at 0 only when an entry is created (`buildEnvironmentCleanupEntry`); `record()` keeps it across a retried deletion. (The `:514` cited earlier is the synthetic entry of the orphaned-branch sweep.) The running version is `APP_VERSION` (`constants.ts`): the launcher's `ORKESTRATOR_VERSION`, else the backend package version.

**Outcome.** Built the recommended option, keyed on a list of versions rather than one stored version. Entries gain `attemptedVersions` (oldest first, at most 16), which `noteAttempt` appends to. When an exhausted entry is read by a backend whose version is not in that list, `EnvironmentCleanupLedger.rearmForVersion` resets `attempts` to 0 and records the version in the same transaction, the reconciler logs `Retrying cleanup for deleted environment <id> once under backend <version>` and runs the entry in the same pass. A failure the upgrade did not fix stops again after the usual eight attempts and logs the "still failing" line again. Going back to an older version that already tried does not re-arm it. Entries written before the field existed are re-armed once by the first backend that reads them. `disk:report` and its tests are unchanged: it reports the current state, and [disk-usage.md](../../development/disk-usage.md) now says a stopped entry may move back to retrying after an upgrade. Tests: four ledger tests (version list order, dedupe and bound; re-arm once per version, not by the exhausting or an older version; no re-arm below the cap or of a missing entry; legacy entries) and three reconciler tests (re-armed entry finishes; unfixed failure stops after exactly one more cycle with one re-arm line and one "still failing" line; the task 4 test).

**Decisions.**

- **When, if ever, to retry?**
  - **Reset the attempts once when the backend version changes (recommended).**
    - Pros: an upgrade is the likeliest fix for a persistent failure; bounded to one more retry cycle per version.
    - Cons: needs the backend version stored on the entry; a failure the upgrade did not fix logs once more.
  - **Only on an explicit user action (a Settings > Disk usage button).**
    - Pros: never surprising.
    - Cons: needs a backend command and renderer work for a rare state.
  - **Never.**
    - Pros: no change.
    - Cons: entries pile up, and `disk:report` is their only exit.

### 6. Stray sweep of user-chosen folders

**Problem.** A stray build-log directory in a user-chosen worktree folder is never swept.

**Context.** The sweep skips anything modified within the last hour and aborts when the owner set cannot be listed completely.

**Investigation.** `sweepStrayWorkspaceDirectories` lists only `getWorktreeBaseDir(context)` (`environment-cleanup-reconciler.ts:360-370`). A per-environment `worktreeBaseDir` is persisted (`storage-projects.ts:751`) and already used as a deletion root (`environment-cleanup.ts:90`).

Rechecked 2026-11-01: the content rule treats empty directories as removable, so in a folder the user chose (say `~/Projects`) an empty directory the user made would pass every existing check. The recommended option's "the content rule becomes the whole safety margin" is therefore not enough to prove ownership there. Worktree directories are named `<project slug>-<branch>` (`createLocalWorktree`, `commands-environment.ts:2206`), and an environment branch ends in its 12-hex namespace, so the directory name matches `parseEnvironmentBranchNamespace`: the same name-based proof the branch sweep already relies on.

**Outcome.** Built the recommended option with that extra rule. The sweep now also lists each live environment's `worktreeBaseDir`, each ledger entry's `worktreeRoot`, and the Settings > Disk usage environment location when the backend has no `--worktree-dir` (decision 12). In those folders a directory is a candidate only when its name parses as a scheme name and its namespace belongs to no live or ledgered environment; then the existing ownership, content and age rules apply. A recorded folder is skipped unless `validateWorktreeLocation` returns it unchanged (canonical, no symlinked ancestor, not the filesystem root, not inside a data directory), and skipped if it is inside a project checkout. A chosen folder that cannot be listed is skipped, not an error. Chosen folders also count as claimed paths, so a chosen folder inside the backend's root is never swept as a stray of that root. Tests: five new sweep tests (only the scheme-named, unowned, build-log-only directory goes, while a non-scheme build-log directory, an empty user directory, one with a file, and ones whose namespace a live environment or a ledger entry owns stay; a folder only a ledger entry records; the Settings location with and without `--worktree-dir`; symlinked, checkout and missing folders skipped while the backend root is still swept; a chosen folder inside the backend root kept). Removing any one of these rules makes at least one of them fail.

**Decisions.**

- **Widen the sweep?**
  - **Yes, to the distinct `worktreeBaseDir` values that live or ledgered environments recorded, with the same ownership and age rules (recommended).**
    - Pros: covers folders Orkestrator itself chose, and nothing else.
    - Cons: a user folder can hold unrelated directories, so the "only build logs" content rule becomes the whole safety margin.
  - **No, keep it to the backend's root.**
    - Pros: never touches a user-chosen folder.
    - Cons: strays there leak forever (a low-cost leak: build logs only).

Deleting an environment, the startup reconciler and the pre-ledger sweeps
remove only state Orkestrator can prove it owns, and dev tooling and tests
must not grow disk without bound. The code shipped in #856 (deletion ledger,
branch policy, reconciler) and #879 (dev profile pruning, test isolation,
pre-ledger sweeps, `disk:report`). The real-stack evidence was recorded on
2026-10-17 (below). On 2026-10-26 the test temporary-directory leaks were fixed,
`disk:report` gained a row for cleanup that has stopped retrying, and
`dev:reset` now removes a profile's macOS Keychain item. On 2026-11-01 the
three open questions were decided and built: no namespace guard, one more
retry cycle for an exhausted entry per new backend version, and a stray sweep
of user-chosen worktree folders limited to directories named by the worktree
scheme. What remains is a live macOS run of the Keychain change.

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
  the UI and recurring diagnostics do not. Since 2026-11-01 a backend version
  not in the entry's `attemptedVersions` re-arms it for one more cycle
  (`rearmForVersion`).
- Sweeps for state whose owner is provable without a ledger:
  - `sweepOrphanedEnvironmentState`: bridge state directories.
  - `sweepOrphanedDesignCanvases`: design canvases. It loads the owner set
    only when some canvas has an owner, so a fresh data directory whose
    environment store was never written no longer logs a refused sweep.
  - `WebAnnotationStorage.init({ environmentExists })`: web annotation
    stores.
  - `sweepPreLedgerDiskState` runs `sweepStrayWorkspaceDirectories`,
    `sweepOrphanedEnvironmentBranches` and `sweepAbandonedTempFiles`. Since
    2026-11-01 the first also covers the worktree folders environments, ledger
    entries and the Settings location recorded, for scheme-named directories
    only.

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
   on macOS, only when the profile's `electronTitle` equals
   `runtimeProfileElectronTitle(id)` (new in `electron/runtime-profile.ts`), so
   an edited `profile.json` can never delete the production app's key, and
   only when the profile is the platform's own development root's profile of
   that id. The item is named by title alone, so a same-id profile under
   another root (a test harness, a temporary root) would otherwise delete the
   real profile's key; `keychainRoots` lets tests name their own root. Any
   other `security` failure becomes a warning (`dev:reset` prints it,
   `dev:prune` appends it to the outcome) and does not fail the removal. Unit
   tests in `profile-cleanup.test.ts` cover deletion of every copy and no
   other item, ordering after state removal, no call when removal fails, no
   call off macOS, refusal of a foreign title, refusal of a same-id profile
   under another root, a locked Keychain, and the prune outcome. The suite's command runner now records `security` calls, so
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

4. ~~Decide whether an exhausted entry blocks namespace reuse.~~ Decided
   2026-11-01: no guard (task 4, decision 9).
5. ~~Decide whether an exhausted entry is ever retried.~~ Built 2026-11-01:
   once per new backend version (task 5, decision 10).
6. ~~Decide whether the stray sweep covers user-chosen folders.~~ Built
   2026-11-01: yes, for scheme-named directories (task 6, decisions 11–13).

### Qualification

Only the macOS Keychain run in item 3. Tasks 4–6 are covered by unit tests;
no live backend was run for them (decision 13 says why none is owed). The 2026-10-17 results are below.

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

None. The three earlier ones (namespace reuse, retrying exhausted entries,
sweeping user-chosen folders) were decided on 2026-11-01: see tasks 4–6 and
decisions 9–13.

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
   profile's title against the one `dev:test` derives from its id; (d) also
   require the profile to be the default development root's profile of that
   id. Chose (b), (c) and (d). Electron sets both names from the app name, so
   (b) still matches every item Electron created; (c) means an edited
   `profile.json` naming `Orkestrator AI` cannot delete the production key;
   (d), added in self-review, stops a same-id profile under a test or
   temporary root from deleting the real profile's key, since the item is
   named by title alone. Cons: a profile created under an older title format,
   or under a non-default root, keeps its item (it says so in a warning).
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

Decisions made on 2026-11-01 while working through tasks 4–6.

9. **Guarding namespace reuse (task 4).** Options: (a) no guard, record the
   invariant; (b) refuse creation while an exhausted entry names the
   namespace. Chose (a), as recommended. Pros: no code for a case no creation
   path produces (every id is a fresh `randomUUID()`); the steps already act
   on exact names and skip live claims, which a test now pins. Cons: a future
   feature that reuses ids or namespaces (a restore) must revisit this; the
   architecture page says so. (b) was rejected because it is dead code today
   and would block a user with no remedy.
10. **When to retry an exhausted entry (task 5).** Options: (a) once per
    backend version change; (b) only on an explicit user action (a Settings >
    Disk usage button); (c) never. Chose (a), as recommended, but keyed on
    the set of versions that have attempted the entry (`attemptedVersions`)
    rather than a single stored version. Pros: an upgrade is the likeliest
    fix; bounded to one cycle (eight attempts with the usual backoff) per
    version, and switching back and forth between two versions does not
    re-arm it again; legacy entries get one retry. Cons: a failure the
    upgrade did not fix logs once more; the store gains a small field; a
    rebuilt development backend that keeps the same version string gets no
    retry (restart with a new `ORKESTRATOR_VERSION` to force one). (b) was
    rejected as new backend and renderer work for a rare state, and (c)
    because entries would then never leave without hand cleanup.
11. **How to prove ownership in a user-chosen folder (task 6).** Options:
    (a) the existing rules alone (unclaimed, build logs and empty
    directories only, an hour old), as the recommended option said; (b) also
    require the directory name to be one creation produces
    (`<project>-<branch>` with an environment namespace) and the namespace to
    belong to no live or ledgered environment; (c) do not widen the sweep.
    Chose (b). Pros: (a) would delete an empty directory the user made in,
    say, `~/Projects`, which Orkestrator cannot prove it owns; (b) uses the
    same name-based proof as the branch sweep. Cons: a stray whose name does
    not follow the scheme (an environment on a branch chosen without a
    namespace) is still never swept there. The backend's own root keeps the
    old rules, since everything in it is Orkestrator's.
12. **Which folders count as chosen (task 6).** Options: (a) only live
    environments' `worktreeBaseDir` and ledger entries' `worktreeRoot`, as
    recommended; (b) also the Settings > Disk usage environment location;
    (c) also remember every folder ever used, in the sweep store. Chose (b),
    but only when the backend has no `--worktree-dir` (with one, the setting
    is ignored for creation, as `resolveEnvironmentWorktreeRoot` does). Pros:
    once the last environment in a folder is deleted and its entry clears,
    (a) alone would stop sweeping the folder that most strays end up in; the
    setting is a folder Orkestrator writes worktrees into. Cons: a folder
    that is no longer the setting and that no environment or entry records is
    not swept; (c) would cover it, at the cost of persisting user paths
    indefinitely, and was not built. Every chosen folder must still pass
    `validateWorktreeLocation` unchanged and lie outside every project
    checkout.
13. **Live evidence for tasks 4–6.** Options: run a disposable `dev:test`
    profile with seeded strays and an exhausted entry, or rely on unit tests.
    Chose unit tests. Pros: the changes are confined to the reconciler and
    the ledger, which the tests drive against the real SQLite store, real git
    repositories and real directories, and a mutation of each safety rule
    makes a test fail. Cons: the startup wiring (`APP_VERSION` from the
    launcher, the hourly sweep in a running backend) is exercised only by the
    existing startup test, not by a live restart across two versions.

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
