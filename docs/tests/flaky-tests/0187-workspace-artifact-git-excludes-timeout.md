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
