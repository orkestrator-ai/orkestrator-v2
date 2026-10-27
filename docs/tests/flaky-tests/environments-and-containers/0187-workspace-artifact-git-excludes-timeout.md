# 0187 — Workspace artifact Git excludes aggregate timeout

- **ID:** 0187
- **Status:** open
- **Date observed:** 2026-10-11

## Observation — 2026-10-11

- Test: `Electron backend command registry > injects workspace artifact git excludes into local worktrees before status reads`.
- Owning file: `apps/backend/tests/commands-integration.test.ts`.
- Command: `mise run test:logged -- --name full-tests -- mise run test`, with the macOS GNU-tool PATH from the testing guide.
- Worker configuration: root group `--parallel=3`; workspace packages used `--parallel=1`, with two package tasks at a time. The default host-capacity runner admitted groups while an isolated browser profile and focused checks were also active.
- Failure: the test exceeded its 5000 ms deadline, reported at 5075.65 ms.
- Root group: 5004 passed, 24 skipped, 2 failed, 1 unhandled error across 253 files in 179.54 seconds. The other failure was the DOM-assertion scanner finding new assertions; those assertions were corrected. A pending Git-fixture command also rejected after its temporary executable had been removed.
- Isolated rerun: `mise run test:logged -- --name command-integration-rerun -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures` passed (exit 0, 18.1 seconds).
- Aggregate evidence: `/tmp/orkestrator-test-run.RaLKCL/root-and-agent-support-tests.log.gz` and its `summary.json`.

## Hypothesis

The aggregate and browser workload delayed the real Git/worktree operations beyond the five-second per-test budget. The owning file passing alone supports a load-sensitive timeout; it does not establish a product failure. Timeout cleanup may also remove a fixture executable while an already-started command still needs it. No test was skipped, loosened, or changed to hide this failure.

## Recurrence — 2026-10-13 (final GitHub clone validation)

- **Original command:** GNU-tool `PATH` prefix from the testing guide with
  `mise run test:logged -- --name fix-final-full-tests -- mise run test`.
- **Worker configuration:** three root workers alongside two workspace and two
  bridge workers; an isolated browser file was also running.
- **Failure:** the same artifact-excludes test exceeded its five-second deadline
  at 5,010.19 ms. A late Git status request then rejected because timeout cleanup
  had removed the temporary worktree (`fatal: cannot change to ...: No such file
  or directory`), recorded as one unhandled error between tests.
- **Root-suite counts:** 5,047 total, 5,022 passed, 24 skipped, 1 failed,
  1 additional error; 204.48 seconds.
- **Isolated rerun:** `mise run test:logged -- --name final-isolate-worktree-status -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed unchanged in 26.3 seconds.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.nZjhnU/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** the timeout and late rejection match the earlier aggregate
  observation. The owning file passes alone; the underlying cause is unconfirmed.

## Recurrence — 2026-10-13 (project navigation validation)

- **Original command:** `mise run test:logged -- --name root-tests -- mise run test`.
- **Worker configuration:** root `--parallel=3`, workspace packages
  `--parallel=1` with two package tasks, bridges with two package tasks. Component
  and isolated-stack browser checks were also active.
- **Failure:** the artifact-excludes test timed out at 5,009.48 ms against its
  5,000 ms deadline.
- **Root-suite counts:** 5,017 passed, 24 skipped, 6 failed and 1 additional error
  across 254 files in 128.80 seconds. The five other failures were shell-tool
  prerequisite failures; migration and firewall owners passed with the documented
  GNU-tool PATH. They are separate from this timeout.
- **Isolated rerun:** `mise run test:logged -- --name commands-integration-rerun -- bun test ./apps/backend/tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 21.5 seconds, using the original PATH.
- **Failure evidence:** `/tmp/orkestrator-test-run.T2WTk5/root-and-agent-support-tests.log.gz`.
- **Aggregate rerun:** with the documented GNU-tool PATH,
  `mise run test:logged -- --name full-tests -- mise run test` passed the root
  group: 5,023 passed, 24 skipped, 0 failed across 254 files in 160.88 seconds.
- **Hypothesis:** this matches the existing load-sensitive Git/worktree timeout.
  No assertions, deadlines or skips were changed.

## Recurrence 2026-10-15 (host-dependent suite fixes)

- **Original command:** `mise run test:logged -- --name full-suite-4 -- mise run test`
  on the default PATH, with the standard group slots and other workers' suites
  on the host.
- **Failure:** five-second timeout at 5,012.27 ms.
- **Suite counts:** backend 7,704 passed, 39 skipped, 2 failed (7,745 tests,
  308.64 s). The other failure is 0216.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1`
  from `apps/backend` passed unchanged (55 tests, 32.14 s).
- **Evidence:** `/tmp/orkestrator-test-run.9os4UH/`.

## Recurrence 2026-10-15 (design-host review fixes)

- **Original command:** `mise run test:logged -- --name complete-tests-final -- mise run test`
  on branch `fix-host-dependent-test-suites-d453802ec96e` (base `dd86fc8c`).
- **Worker configuration:** four workspace slots, one root slot, two bridge
  slots and one protocol slot; workspace package tests used two Bun workers.
- **Failure:** the same artifact-excludes test exceeded its five-second deadline
  at 5,008.29 ms. A pending Git command then rejected after timeout cleanup
  removed its worktree, producing one unhandled error between tests.
- **Suite counts:** backend 7,705 passed, 39 skipped, one failed and one
  additional error across 423 files (235.64 s). All other full-suite groups
  passed. The workspace group had passed the preceding full run.
- **Isolated rerun:** `mise run test:logged -- --name backend-integration-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed unchanged in 25.9 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.gyVhpj/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the timeout and late cleanup rejection match the existing
  aggregate-load symptom. No backend code, assertion, deadline or skip was changed.

## Recurrence — 2026-10-16 (coordinator network lockdown main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64).
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. The browser component suite also ran during the start of the aggregate.
- **Suite counts:** backend 8,462 passed, 40 skipped, seven failed and one between-tests error across 453 files (297.75 seconds). The aggregate exited 1 after 352.2 seconds; the bridge group also hit its ACP no-progress watchdog. Root, protocol and all other workspace packages passed.
- **Owning-file rerun:** `mise run test:logged -- --name merge-commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged file (exit 0) in 23.0 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.TpifY7/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `summary.json`; outer artifact `/tmp/orkestrator-test-run.jvncxJ/merge-tests.log.gz`.
- **Failure:** the artifact-excludes case exceeded its 5000 ms deadline at 5053.01 ms. A late Git request rejected after fixture cleanup removed its worktree, producing the between-tests error. The six diff-statistics timeouts are recorded under 0162.
- **Assessment:** the isolated pass confirms an intermittent recurrence. Aggregate contention remains an unconfirmed hypothesis. No implementation, assertion, timeout or skip changed.

- **Final aggregate rerun:** `mise run test:logged -- --name merge-tests-final -- mise run test` passed all four groups (exit 0, 277.5 seconds), including all five bridges (88.0 seconds). No tests, assertions, timeouts or skips changed.

## Recurrence — 2026-10-16 (preview header authority validation)

- **Original command:** `PATH="/opt/homebrew/bin:$PATH" mise run test:logged -- --name full-tests-host-python -- mise run test`
  on macOS arm64, Bun 1.4.3, working tree based on `6892c000b`. The PATH
  selects the installed Python for unrelated archive fixtures; the default
  Python shim hung in both aggregate and isolated migration-test runs.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Workspace admission waited
  141.6 seconds for the preceding same-worktree run to stop.
- **Failure:** the artifact-excludes test timed out at 5,011.70 ms against its
  5,000 ms deadline, followed by one between-tests error after fixture cleanup.
- **Suite counts:** backend 8,470 passed, 40 skipped, one failed and one
  additional error across 453 files (321.12 seconds). All other workspace
  packages and all other aggregate groups passed; aggregate exit 1 (517.4 s).
- **Isolated rerun:** `PATH="/opt/homebrew/bin:$PATH" mise run test:logged -- --name commands-integration-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0, 33.0 seconds).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.SL2KEC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and `summary.json`; outer artifact directory
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.XHkW6I`.
- **Assessment:** the timeout and isolated pass match the existing aggregate
  symptom. Load sensitivity remains a hypothesis. No assertions, deadlines,
  skips or implementation in this owner changed.


## Codex catalogue review final validation — 2026-10-17

`mise run test:logged -- --name final-full-tests -- mise run test` ran with
4/1/2/1 workspace/root/bridge/protocol slots and two isolated backend workers
on macOS arm64 (Bun 1.4.3), sharing the host with other worktrees.

The workspace-artifact Git excludes case exceeded its 5000 ms deadline at
5016.18 ms.

The unchanged owning file passed `mise run test:logged -- --name
commands-owner-final-rerun -- bun test --cwd apps/backend --preload
../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1
--only-failures` (exit 0, 40.3 seconds). Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NfVWIS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
(compressed when the aggregate completes). The isolated pass confirms
intermittence; host contention remains a hypothesis. No owning implementation,
assertion, timeout or skip changed.

Final aggregate totals: backend 8814 passed, 41 skipped, ten failed and three
between-tests errors across 8865 tests in 472 files (541.38 seconds).
Toolchain had 90 passed and one failed. Root, bridges, protocol and every
other workspace package passed; aggregate exit 1 after 852.0 seconds.

## Pi and Cursor agent-test logins main merge validation — 2026-10-17

Aggregate command, worker configuration, counts and evidence are recorded in [0211](0211-cleanup-retry-aggregate-timeout.md#pi-and-cursor-agent-test-logins-main-merge-validation--2026-10-17).

The first cleanup-owner rerun, `mise run test:logged -- --name merge-cleanup-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`, timed out `injects workspace artifact git excludes into local worktrees before status reads` at 5032.53 ms, followed by a late fixture-cleanup rejection (54 passed, one failed, one error; 40.61 seconds). Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.TCtpzn/merge-cleanup-owner.log.gz`.

The unchanged owning file then passed `mise run test:logged -- --name merge-cleanup-post-workspace -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` after workspace validation ended (exit 0, 28.4 seconds). This confirms intermittence; host contention remains a hypothesis. No implementation, assertion, timeout or skip changed.


## MCP live apply review follow-up — 2026-10-18

- **Original command:** `mise run test:logged -- --name committed-full-tests -- mise run test`, Bun 1.4.3 on macOS arm64, with other worktrees sharing the host. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Workspace admission waited 132.5 seconds.
- **Failure:** `Electron backend command registry > injects workspace artifact git excludes into local worktrees before status reads` in `apps/backend/tests/commands-integration.test.ts` exceeded its 5000 ms deadline at 5012.10 ms.
- **Suite counts:** backend 9066 passed, 41 skipped and one failed across 9108 tests in 481 files (354.40 seconds). Aggregate exited 1 after 513.4 seconds; the other failures were existing README expectations in the install-script and Markdown round-trip tests. Bridges and the Codex protocol check passed. The preceding aggregate passed the backend package unchanged.
- **Isolated rerun:** `mise run test:logged -- --name backend-fixture-owning-file -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 13.9 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.hcFAOW/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.5zrcnt/committed-full-tests.log.gz`.
- **Assessment:** the isolated pass confirms intermittence for this occurrence. Shared-host contention remains a hypothesis. No owning implementation, assertion, deadline or skip changed.

## Upgrade-channel second main merge — 2026-10-18

- **Original command:** the testing guide's macOS GNU-tool PATH with `mise run test:logged -- --name merge2-full-cold -- mise run test`, merging `origin/main` at `62c5c696` into pre-merge HEAD `129e3887`.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; backend used two isolated workers. Workspace admission waited 186.6 seconds, while component and isolated browser checks also ran on the shared host.
- **Failure:** the same artifact-excludes test exceeded its 5000 ms deadline at 5010.61 ms. Backend reported 9114 passed, 41 skipped and one failed across 9156 tests in 486 files (343.34 seconds). All other workspace packages, root/support, bridges and protocol regeneration passed. The aggregate exited 1 after 594.7 seconds including capacity waits.
- **Isolated rerun:** `mise run test:logged -- --name merge2-command-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, passed the unchanged owning file (exit 0, 15.3 seconds).
- **Evidence:** `orkestrator-test-run.vycZlB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.BmgkR3/merge2-full-cold.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Contention remains a hypothesis; no implementation, assertion, deadline or skip changed.

## Resolution — 2026-10-20

- **Status:** open
- **Shared root cause (shared fixture state, not slow Git):** `createCommandFixtures()`
  gives every context the same default data directory,
  `$TMPDIR/orkestrator-command-tests`. Every command-fixture file in every
  concurrent test process on the host (other worktrees included) uses it. Two
  things live in that directory:
  - The environment cleanup ledger, a SQLite store with WAL and
    `synchronous = FULL`. `bun:sqlite`'s busy handler blocks the event loop for
    up to 10 s while another process holds the write lock.
  - The `terminal-history` root, which `deleteTerminalHistories` lists in full
    on every deletion, reading each manifest.

  On the test host the ledger held 13 entries left by other processes and earlier runs, several of
  them at 8 attempts, and the history root held 438 directories. Every
  `delete_environment` records and updates ledger entries. Every successful
  deletion then starts a background `scheduleEnvironmentCleanupReconcile`
  pass. That pass outlives the test, retries ledger entries that other
  processes recorded and writes more ledger updates. Deletion cases here were
  therefore paced by other processes' writes.
  Reproduction: while a second process held the shared ledger's write lock for
  1 s at a time, the diff-statistics cases (all of which delete their
  environment) went from about 0.4 s to 1.2 s each. With the fix, the same
  probe left them unchanged.
- **Second, case-specific cause (Bun subprocess exit lost):** this case
  kept timing out under stress after the data-directory fix (6 timeouts in 48
  copies), so the run was instrumented further:
  - A wrapper on the `git-docker-scan` admission pool showed the cause. The
    tracked diff scan that `start_environment` begins held the new worktree's
    per-target lease (`maxPerTarget: 1`) for more than 4 s, and the test's
    interactive `get_local_git_status` read queued behind it.
  - A timed Git shim and env-gated spawn-lifecycle logging in `shell.ts`, both
    temporary and since reverted, showed what held the lease. In every
    reproduction the scan's `git rev-parse --verify --quiet <sha>^{commit}`
    (`gitRefExists`) exited in about 20 ms, but Bun delivered no `exit`, no
    stdout/stderr EOF and no `close` for it. `runCommand` therefore waited out
    its 10 s timeout (+100 ms grace). Only then did the scan continue and
    release the lease, and the queued read ran against the already-deleted
    worktree. That is the late `fatal: cannot change to …` rejection.
  - In all four traces the lost child had been spawned within about 1 ms of
    two other spawns: the baseline check's `merge-base` and the test's own
    `execFile` calls `git rev-parse --git-dir` / `--git-path info/exclude`.
    A standalone loop of the same mixed spawns (9,600 under load) did not
    reproduce the loss, so the exact Bun trigger is unproven.
- **Case-specific fix:** the test now finds the linked worktree's Git
  directory and `info/exclude` from Git's documented layout instead of
  spawning `git rev-parse`. It asserts `.git` is a file, follows it to the
  private Git directory, then follows `commondir`. The final
  `git check-ignore` still proves that Git honours the file.
  - With this change: 0 lost exits and 0 failures in 48 instrumented stress
    copies plus 24 clean ones. The same harness had shown about one failure
    every 1–2 rounds of 6 copies before.
  - Residual risk: the Bun lost-exit defect itself is not fixed. If it hits any
    product subprocess, that operation still stalls for its command timeout.
    It should be tracked as a runtime issue.
- **Fix (test file only, `apps/backend/tests/commands-integration.test.ts`):**
  - The file wraps `createContext` so that every context, unless it passes its
    own `dataDir`, uses a per-process data directory. That directory is created
    with `createOwnedTempDir("orkestrator-command-integration-")` and swept by
    `sweepStaleTempDirs`. In `afterAll` the file cancels that directory's
    scheduled cleanup reconcile, closes its ledger connection and removes it.
    The ledger, its background retries and terminal histories now hold only
    this file's own environments.
  - Container ownership is namespaced by data directory, so the
    running-container Docker fake's owner string is rewritten to match. A guard
    fails loudly if the fixture script stops naming the owner.
  - `createGitWorktreeWithOrigin` used to spend ten Git processes per test,
    including a bare init and a push. It now builds the origin/worktree pair
    once per file and copies it into each test's temporary directory with the
    `origin` URL repointed. Each test still owns an independent repository and
    remote. The diff-statistics cases drop from 18 to 9 Git processes each.
  - No assertion, deadline or skip changed. `command-fixtures.ts` is shared by
    about 27 files and was left unchanged. Moving its default data directory to
    a per-process path would extend this fix to those files.
- **This case (mean/max seconds):**
  - Alone: 0.68/0.77 before, 0.32/0.33 after. Under stress: 1.54/5.01 before (2 timeouts), 0.61/0.78 after.
- **Verification:**
  - Owning file alone: `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts`
    took 15.4–16.1 s before (55 pass) and 12.3–14.2 s after (55 pass, 3+ runs).
    The "still failing after 8 attempts" warnings from other processes' ledger
    entries are gone.
  - Aggregate simulation: 6 concurrent copies of the file, 24–40 `yes` CPU
    burners and up to 6 other command-fixture files at once (load average
    15–43).
    - Before: 2 of 18 runs failed. Each failure was the artifact-excludes case
      at 5.01 s, followed by the late `fatal: cannot change to …` unhandled
      rejection between tests.
    - After: 0 of 72 runs failed.
  - `bunx tsc --noEmit -p tsconfig.test.json`, `oxlint` and `oxfmt --check`
    pass for the file.

- **Consolidation (2026-10-20):** the per-process data directory and the copied origin/worktree template were moved from the owning test files into `apps/backend/tests/command-fixtures.ts`, so every command-fixture file now gets its own data directory (removed in the fixture's `afterAll` after cancelling scheduled cleanup and closing the ledger). The 28 command-fixture files plus the coordinator and worktree-snapshot owners passed together afterwards: 582 passed, 1 skipped, 0 failed.

## Recurrence — 2026-10-26

- Todo 0211 branch (`fdcb5345d`, which does not touch `apps/backend`):
  `mise run test` on a shared macOS host at load average 23–30 failed this
  case at 13,448 ms with "a beforeEach/afterEach hook timed out for this
  test." The complete unchanged owner then passed alone
  (`mise run test:logged -- --name 0211-commands-integration-owner -- bun test --cwd apps/backend ./tests/commands-integration.test.ts --parallel=1`,
  28.7 s). It did not fail in a full `mise run test` or a focused rerun on a
  detached `origin/main` (`ce205ad34`) worktree under the same load.
- Reopened: the 2026-10-20 fix removed one cause, but the case still misses
  its hook deadline in a loaded aggregate. Cause not established. See
  [1101](../aggregate-validation-runs/1101-codex-typed-prompts-0211-validation.md).

## Recurrence during 0247 validation (2026-10-27 follow-up)

The review of `b74e02ce0` captured the same artifact-excludes case timing out
at five seconds in `mise run test` (the full run had six failures). The
complete unchanged `commands-integration.test.ts` owner then passed alone:
`mise run test:logged -- --name previously-failing-commands -- bun test
--cwd apps/backend ./tests/commands-integration.test.ts --parallel=1 --only-failures`,
exit 0, 18.5 s. Reopened on this evidence; this establishes a recurrence of
the timeout, not that the previously fixed shared-ledger cause has returned.
No deadline or assertion was changed.

## Recurrence — 2026-10-27

On the todo 0160 branch (`0d325203a`, base `863b57821`), `mise run test` at
load average about 150 failed this case at 5,018 ms. The owner run alone
(`mise run test:logged -- --name re-commands-integration -- bun test --cwd apps/backend --parallel=1 ./tests/commands-integration.test.ts`)
failed on the branch twice (once this case, once `enables git's scan caches
on a newly created worktree`), and on the unchanged base twice of three
(this case, 5,016 ms and 5,496 ms). The branch does not touch the owner or
anything it imports. See
[1170](../aggregate-validation-runs/1170-codex-saved-rules-0160-validation.md).
