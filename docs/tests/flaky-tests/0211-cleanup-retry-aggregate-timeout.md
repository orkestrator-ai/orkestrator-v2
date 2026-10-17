# Backend cleanup retry exceeds the aggregate deadline

- **ID:** 0211
- **Status:** open

Observed: 2026-10-14

- Test: `Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry`
- Owner: `apps/backend/tests/commands-integration.test.ts` (was `tests/unit/electron/commands-integration.test.ts` when observed)
- Original command: `mise run test:logged -- --name full-tests -- mise run test`
- Worker configuration: three root Bun workers, alongside workspace, bridge and protocol groups and other host validations.
- Failure: default 5000ms timeout, observed duration 6336.21ms.
- Root result: 5043 pass, 24 skip, 6 fail in 197.16 seconds. Five other failures involved macOS shell-tool prerequisites; validation was restarted with the documented GNU tool path.
- Evidence: `/tmp/orkestrator-test-run.H9WZ9L/root-and-agent-support-tests.log.gz`.
- Isolated rerun: documented GNU `PATH`, then `mise run test:logged -- --name cleanup-isolated -- bun test ./tests/unit/electron/commands-integration.test.ts --parallel=1 --only-failures`; unchanged owning file passed in 35.0 seconds.

Hypothesis: process cleanup, worktree inspection and fixture I/O were delayed by concurrent host load. Warnings about intentionally injected cleanup failures are expected in this test. No assertions or deadlines were loosened.

## Recurrence on 2026-10-15

The OpenCode model-selection validation aggregate reproduced this unchanged
test's timeout after 7450.55 ms against the default 5000 ms deadline. The same
owning file also timed out in `deletes an environment only after all three local
server kinds exit` after 5559.99 ms.

The unchanged owning file passed alone in 38.1 seconds:

```bash
mise run test:logged -- --name command-integration-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `/tmp/orkestrator-test-run.lhp1N0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No assertions or deadlines were changed.

## Recurrence during main merge validation — 2026-10-15

- **Test:** `persists safe cleanup failure details and permits a backend
  deletion retry` exceeded its 5,000 ms deadline at 7,277.24 ms.
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name merge-main-full-suite -- mise run test`.
- **Worker configuration:** backend package `--parallel=2`, two workspace
  package tasks, alongside the other aggregate groups and other host validations.
- **Suite counts:** backend 7,745 passed, 39 skipped, 6 failed and one
  between-tests error across 7,790 tests in 427 files (361.91 seconds).
  The whole aggregate finished in 594.9 seconds; root and protocol groups passed,
  while the bridges group also reported the ACP hook timeout tracked as 0219.
- **Evidence:** `/tmp/orkestrator-test-run.jDL6Dp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** the documented GNU-tool PATH with
  `mise run test:logged -- --name commands-integration-isolated -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file in 47.2 seconds.
- **Disposition:** aggregate-only deadline failures recorded without changing
  assertions, deadlines or skips. Host contention is a hypothesis, not a proven
  cause.

## Recurrence — 2026-10-15 (coordinator mail branch merge)

With the testing guide's GNU-tool PATH,
`mise run test:logged -- --name merge-repository-tests -- mise run test`
timed out the same cleanup-retry test at 5870.46 ms against its 5000 ms
limit. The aggregate reserved 4/1/2/1 workspace/root/bridge/protocol slots,
with two concurrent workspace package tasks and two backend Bun workers.
Backend results were 7,903 passed, 39 skipped and one failed across 433 files
(331.16 seconds); the aggregate finished in 435.9 seconds. Root separately
hit the Pi staging timeout tracked in 0178; bridges and protocol passed.
Evidence:
`/tmp/orkestrator-test-run.XSWXem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

After the aggregate and the Pi isolated rerun finished, the same GNU-tool PATH
with
`mise run test:logged -- --name merge-cleanup-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
passed the unchanged owning file, exit 0, in 24.1 seconds. Host contention
remains an unconfirmed hypothesis. No timeout, assertion or skip was changed.

## Coordinator launch-defaults review validation — 2026-10-16

Recurred in the full suite for `0d254a3a`; the unchanged owning file passed
separately with one isolated Bun worker. Exact failures, suite counts,
commands, durations and evidence are recorded in
[0255](0255-backend-fixtures-launch-defaults-validation.md).
No assertion, deadline or skip was changed.

## Recurrence during Multi Review validation diagnostics (2026-10-16)

- While the aggregate was active, `mise run test:logged -- --name commands-integration-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` timed out in the unchanged cleanup-retry case at 6750.13 ms. The file reported 52 passed and three timeouts in 127.9 seconds.
- After the aggregate finished, the same owning-file command with `--name commands-integration-final-rerun` passed unchanged in 32.1 seconds (exit 0).
- Evidence: `/tmp/orkestrator-test-run.3kSG12/commands-integration-rerun.log.gz`. No cleanup implementation, assertion, timeout or skip changed; host contention remains a hypothesis.

## Recurrence — 2026-10-16 (gateway terminal fallback backoff)

`mise run test` on `feat/gateway-terminal-fallback-backoff`, which changed no
backend code, timed out this unchanged test at 7473.73 ms against its 5000 ms
limit while other worktrees ran suites on the host. Backend results were 8,085
passed, 40 skipped and 3 failed across 438 files (324.01 seconds); the other
failures are case 0248 and the deterministic provider line-limit check.
Evidence:
`/tmp/orkestrator-test-run.3Pp4em/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

`mise run test:logged -- --name backend-cmd-integration-file -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
passed the unchanged owning file in 32.3 seconds. No timeout, assertion or skip
was changed.

## Mobile layout merge validation recurrence — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU host utilities preferred in PATH, on `mobile-layout-gaps` while merging `origin/main`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees and component browser validation were active on the host.
- **Failure:** The safe cleanup failure and deletion retry case timed out at 7469.37 ms against its 5000 ms limit.
- **Suite counts:** backend 8,320 passed, 40 skipped and 4 failed; root/support 2,998 passed, 1 skipped and 1 failed. All other workspace packages, bridges and protocol verification passed. The logged aggregate exited 1 after 544.1 s.
- **Isolated rerun:** `mise run test:logged -- --name merge-commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged owning file in 44.2 s (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.Z1q1Ht/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.fZgI1l/merge-tests.log.gz`.
- **Disposition:** recurrence confirmed by the isolated pass; shared host contention remains an unconfirmed hypothesis. No assertions, deadlines or skips changed.


## Mobile layout follow-up main merge — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-latest-tests -- mise run test`
  with the testing guide's GNU-tool PATH, merging `origin/main` at `222599b0`
  into `mobile-layout-gaps`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated workers while other validations shared
  the host.
- **Suite counts:** backend 8,380 passed, 40 skipped and ten failed across
  8,430 tests in 449 files (556.88 seconds). Root had three failures; other
  workspace packages, bridges and protocol verification passed. The aggregate
  exited 1 after 671.2 seconds.
- **Failure:** `persists safe cleanup failure details and permits a backend deletion retry` timed out at 10002.70 ms against a 5000 ms limit. The following `rejects a direct deletion while the backend merge guard is active` received `Backend is shutting down; environments cannot be deleted` instead of the merge-guard refusal (2089.57 ms). Both passed in the owning-file rerun; the shutdown overlap is a hypothesis.
- **Owning-file rerun:** `mise run test:logged -- --name merge-latest-commands-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  with the same GNU-tool PATH passed the entire unchanged owning file (exit 0,
  23.7 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.hmA9t0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.1X6sCk/merge-latest-tests.log.gz`.
- **Disposition:** isolated pass confirms an intermittent recurrence. Host
  contention remains a hypothesis; no implementation, assertion, timeout or
  skip changed.

## Coordinator launch-defaults main merge — 2026-10-16

`mise run test:logged -- --name merge-tests -- mise run test`, with the testing
guide's GNU-tool PATH, reserved 4/1/2/1 workspace/root/bridges/protocol slots.
Backend used two isolated Bun workers while another worktree's aggregate
shared the host. Backend reported 8,413 passed, 40 skipped, five failed and
one between-tests error across 8,458 tests in 450 files (364.58 seconds).
The aggregate exited 1 after 453.6 seconds; protocol's separate timeout is
recorded in [0256](0256-workspace-change-probe-aggregate-timeout.md).

The unchanged `persists safe cleanup failure details and permits a backend deletion retry`
case exceeded its 5000 ms budget at 8189.80 ms.

`mise run test:logged -- --name merge-commands-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
passed the entire unchanged owning file (exit 0, 27.1 seconds). Evidence:
`/tmp/orkestrator-test-run.H7G9oK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
outer artifact `/tmp/orkestrator-test-run.e7nGed/merge-tests.log.gz`.
Host contention remains an unconfirmed hypothesis; no assertion, timeout or
skip changed.

## Codex sub-agent review validation recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers. Other worktree validations shared the host, and the component browser suite ran alongside the aggregate.
- **Aggregate evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.8J9UKQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. The aggregate exited 1 after 582.8 seconds. Backend reported 8,618 passed, 41 skipped, ten failed and one between-tests error across 8,669 tests; desktop also had a timeout (0258), and root failed on the pre-existing missing metadata in case 0265. Bridges and protocol verification passed.
- **Failure:** `persists safe cleanup failure details and permits a backend deletion retry` exceeded its 5000 ms budget at 9438.69 ms.
- **Owning-file rerun:** `mise run test:logged -- --name commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 19.9 seconds.
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Multi Review restart-continuation validation — 2026-10-17

- Original command: `mise run test:logged -- --name full-restart-continuation -- mise run test` on `9da80451` plus the Multi Review restart-continuation change, macOS arm64, alongside another environment's full suite on the same host.
- Aggregate: backend 8,800 passed, 41 skipped, four failed and one between-tests error across 472 files (505.46 seconds). One failure was the change's own provider line-limit breach, fixed before commit; the other three were five-second timeouts in unchanged owners. All other workspace packages and the root, bridge and protocol groups passed.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vczqfd/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- This test timed out at 6482.48 ms. In the same owner, `deleting an environment drops its counts from the snapshot` also timed out (5236.95 ms), recorded as [0300](0300-diff-stats-deletion-aggregate-timeout.md).
- Unchanged owning-file rerun: `bun test ./tests/commands-integration.test.ts` from `apps/backend` passed 55 of 55.
- No assertion, timeout, skip or implementation in this owner changed.
