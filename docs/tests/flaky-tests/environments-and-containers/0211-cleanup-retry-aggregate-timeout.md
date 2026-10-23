# Backend cleanup retry exceeds the aggregate deadline

- **ID:** 0211
- **Status:** resolved

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
[0255](../aggregate-validation-runs/0255-backend-fixtures-launch-defaults-validation.md).
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
recorded in [0256](../backend-services-and-tooling/0256-workspace-change-probe-aggregate-timeout.md).

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

## Codex catalogue review follow-up recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`
  (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reservations
  4/1/2/1 slots, with two backend workers and concurrent isolated browser and
  other-worktree validation).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.jlxHbv/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
  This obsolete aggregate was interrupted after an integration test moved
  during discovery; its workspace result is incomplete and has no final
  backend test totals. A fresh aggregate validates the final tree.
- **Failure:** `Electron backend command registry > persists safe cleanup failure
  details and permits a backend deletion retry` in
  `apps/backend/tests/commands-integration.test.ts` exceeded its 5000 ms
  deadline at 5361.69 ms.
- **Owning-file rerun:** `mise run test:logged -- --name cleanup-retry-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0) in 37.2 seconds.
- **Assessment:** the isolated pass confirms intermittence. Host contention
  remains a hypothesis; no lifecycle source, assertion, timeout or skip changed.


## Codex catalogue review final validation — 2026-10-17

`mise run test:logged -- --name final-full-tests -- mise run test` ran with
4/1/2/1 workspace/root/bridge/protocol slots and two isolated backend workers
on macOS arm64 (Bun 1.4.3), sharing the host with other worktrees.

The cleanup-retry case exceeded its 5000 ms deadline at 7250.79 ms.

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

- Original command: `mise run test:logged -- --name merge-tests -- mise run test`, Bun 1.4.3, macOS arm64, with system Python and the testing guide's GNU tools preferred in PATH. Workspace/root/bridges/protocol reserved 4/1/2/1 worker slots; backend used two isolated workers. Other worktrees shared the host; bridges waited 614.1 seconds for capacity.
- Aggregate: backend 8,930 passed, 41 skipped, three failed and one between-tests error across 8,974 tests in 477 files (660.67 seconds). Root/support had 3,037 passed, one skipped and one failed across 3,039 tests in 140 files (286.45 seconds). Every other workspace package, bridges and the protocol check passed. Aggregate exit 1 after 799.1 seconds.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.zGiSwY/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; root/support is in the same directory. Outer artifact: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ay4g6L/merge-tests.log.gz`.
- Failure: `persists safe cleanup failure details and permits a backend deletion retry` exceeded its 5000 ms deadline at 6403.68 ms.
- First owning-file rerun: `mise run test:logged -- --name merge-cleanup-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed this case but timed out the artifact-excludes case (0187); 54 passed, one failed and one error (40.61 seconds). Artifact: `orkestrator-test-run.TCtpzn` under the host temporary directory.
- Post-workspace owning-file rerun: `mise run test:logged -- --name merge-cleanup-post-workspace -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed unchanged, exit 0 (28.4 seconds).
- The later owning-file pass confirms intermittence. Shared-host contention remains a hypothesis; no implementation, assertion, timeout or skip changed.

## Refused-cell validation recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`. No backend implementation or owning test changed.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on the shared 18-slot host; backend used two isolated workers. The workspace group waited 686.3 seconds for capacity.
- **Failure:** the cleanup-retry case exceeded its 5000 ms deadline at 5735.01 ms.
- **Suite counts:** backend 8818 passed, 41 skipped and three failed across 8862 tests in 473 files (366.20 seconds). The other backend failures are the activity-batch cases in 0247; bridges separately hit 0214. Root/support and protocol passed. The aggregate exited 1 after 1101.3 seconds.
- **Owning-file rerun:** `mise run test:logged -- --name cleanup-retry-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 22.8 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.nN9Z1G/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Shared-host contention remains a hypothesis. No assertion, deadline or skip changed.

## Slash catalogue main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU tools preferred in PATH (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers alongside other worktrees on the shared host.
- **Failure:** `Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry` exceeded its 5000 ms deadline at 6316.85 ms.
- **Suite counts:** backend reported 8933 passed, 41 skipped and four failed across 8978 tests in 476 files (639.61 seconds). All other workspace packages and root/bridge/protocol groups passed; aggregate exited 1 after 738.6 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.lAr6wP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer `orkestrator-test-run.S55BjO/merge-tests.log.gz` in the same temporary root.
- **Owning-file rerun:** `mise run test:logged -- --name merge-commands-integration-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 24.2 seconds).
- **Assessment:** the isolated pass confirms intermittence. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Clean-review branch main merge — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, merging `origin/main` at `58566c9d` into `verify-fix-pr-b8cf5787ccea-r1` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers while other worktrees shared the host.
- **Aggregate:** backend reported 8,992 passed, 41 skipped, two failed and one between-tests error across 478 files (392.72 seconds). All other workspace packages and root, bridge and protocol groups passed. The logged aggregate exited 1 after 497.7 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XctCGL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer `orkestrator-test-run.OkaxRX/merge-tests.log.gz` in the same temporary root.
- **Failure:** `Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry` exceeded its 5000 ms deadline at 6347.48 ms.
- **Owning-file rerun:** `mise run test:logged -- --name merge-cleanup-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 16.6 seconds).
- **Assessment:** the unchanged isolated pass confirms intermittence; shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Coordinator pane drop-test main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` on Bun 1.4.3, macOS arm64. Workspace/root/bridge/protocol reserved 4/1/2/1 slots, with two backend workers, concurrent component browser validation and other worktrees sharing the host.
- **Failure:** `Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry` in `apps/backend/tests/commands-integration.test.ts` exceeded its 5000 ms deadline at 5054.22 ms.
- **Owning-file rerun:** `mise run test:logged -- --name merge-commands-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 19.6 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xZ3kaR/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** the isolated pass confirms intermittence. Shared-host contention remains an unconfirmed hypothesis; no owning implementation, assertion, timeout or skip changed.

Final aggregate exited 1 after 477.8 seconds. Backend reported 8978 passed, 41 skipped and one failed across 9020 tests in 478 files (423.04 seconds). Root/support reported the Pi timeout above; all other workspace packages, bridges and the Codex protocol check passed. Both failing owning files passed unchanged alone. Formatting, lint, typechecking and the full component browser suite also passed. Additional real-stack, Electron, Docker and iOS scenario suites were omitted because the branch changes a component-browser test and documentation, and conflict resolution changes documentation only.


## Landing-page main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` with the testing guide's GNU-tool PATH prefix; workspace/root/bridges/protocol groups used 4/1/2/1 slots and backend used two isolated workers. Other worktrees and browser suites were active.
- **Owning-file failures:**

- Electron backend command registry > backend-owned diff statistics > enables git's scan caches on a newly created worktree [5800.37ms]
- Electron backend command registry > backend-owned diff statistics > deleting an environment drops its counts from the snapshot [6439.62ms]
- Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry [5037.44ms]

- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-backend-owners -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts ./src/core/environment-move.test.ts ./src/core/coordinator-service.test.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed all four unchanged files with one worker, exit 0, in 121.2 seconds.
- **Evidence:** `orkestrator-test-run.iFuHsy/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Backend reported 9025 passed, 41 skipped and 17 failed across 9083 tests, with 12 errors between tests.
- **Assessment:** confirmed intermittent recurrence; no implementation, assertion, timeout or skip in these owners changed. Shared-host contention remains a hypothesis.

## Transcript-paging main merge — 2026-10-18

The testing guide's GNU-tool PATH prefix followed by `mise run test:logged -- --name merge-tests -- mise run test` repeated the 5000 ms deadline at 5930.48 ms. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside browser validation and other worktrees. The same PATH prefix with `mise run test:logged -- --name merge-cleanup-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged owner, exit 0, in 26.4 s. Evidence: `orkestrator-test-run.Yk2l1H/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. No source, assertion, timeout or skip changed.

Final aggregate counts: backend 9085 passed, 41 skipped and two failed across 9128 tests in 483 files (502.39 s). The aggregate exited 1 after 1473.5 s including queue time. The other backend failure is recorded in 0165; bridges and protocol passed.

## README regression-test main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, merging `origin/main` at `f51c7252` into `bdaee060`; Bun 1.4.3 on macOS arm64. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers, alongside browser validation and other host work.
- **Aggregate result:** exit 1 after 376.6 seconds logged. Backend reported 9089 passed, 41 skipped, three failed and one between-test error across 9133 tests in 485 files. All other workspace packages, root/support, bridges and protocol regeneration passed.
- **Failure:** `Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry` exceeded 5000 ms at 6307.74 ms.
- **Owning-file rerun:** `mise run test:logged -- --name merge-commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0, in 14.3 seconds logged.
- **Evidence:** `orkestrator-test-run.wmdv2p/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains a hypothesis; no implementation, assertion, timeout or skip changed.
- **Warm full-suite validation:** `mise run test:logged -- --name merge-tests-warm -- mise run test` passed all four groups, exit 0, in 339.7 seconds logged.


## Upgrade-channel second main merge warm run — 2026-10-18

- **Original command:** the testing guide's macOS GNU-tool PATH with `mise run test:logged -- --name merge2-full-warm -- mise run test`, merging `origin/main` at `62c5c696` into `129e3887`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside Electron validation on the shared host.
- **Failure:** `Electron backend command registry > persists safe cleanup failure details and permits a backend deletion retry` in `apps/backend/tests/commands-integration.test.ts` exceeded 5000 ms at 6645.41 ms.
- **Suite counts:** backend 9109 passed, 41 skipped and six failed across 9156 tests in 486 files (579.33 seconds). Every other workspace package, root/support, bridges and protocol regeneration passed; aggregate exit 1 after 596.4 seconds.
- **Isolated rerun:** `mise run test:logged -- --name merge2-integration-warm-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, passed the unchanged owning file (exit 0, 24.4 seconds).
- **Evidence:** `orkestrator-test-run.4BSigl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.EJfRvy/merge2-full-warm.log.gz`, below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Shared-host contention remains a hypothesis; no implementation, assertion, deadline or skip changed.

## Keep-open picker main merge — 2026-10-19

- **Original command:** the testing guide's macOS GNU-tool PATH with `mise run test:logged -- --name merge-tests -- mise run test`, merging `origin/main` at `d28f0d63` into `24d4ac1c`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside browser validation.
- **Failure:** `persists safe cleanup failure details and permits a backend deletion retry` exceeded the 5000 ms deadline at 6160.02 ms.
- **Suite counts:** backend reported 9113 passed, 41 skipped and two failed across 9156 tests in 486 files (339.59 seconds). The aggregate exited 1 after 399.9 seconds; desktop also had a dependency-install prerequisite failure and Claude had the fixture race in 0385. Root/support and protocol passed.
- **Owning-file rerun:** the same GNU-tool PATH with `mise run test:logged -- --name merge-backend-commands-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the unchanged file, exit 0, in 15.8 seconds logged.
- **Evidence:** `orkestrator-test-run.4pe57b/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. Shared-host contention remains a hypothesis; no backend implementation, assertion, timeout or skip changed.

The subsequent full run, `mise run test:logged -- --name merge-tests-installed -- mise run test`, passed all four groups unchanged (exit 0, 266.7 seconds logged).

## Resolution — 2026-10-20

- **Status:** resolved
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
  - Alone: 0.26/0.28 before, 0.10/0.10 after. Under stress: 0.22–0.44/0.54 before, 0.14/0.16 after.
  - The case runs two deletion attempts, the failed one and the retry, so it made two rounds of ledger writes against the shared store.
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
