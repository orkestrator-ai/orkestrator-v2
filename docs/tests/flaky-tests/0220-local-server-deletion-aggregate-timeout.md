# Local-server deletion aggregate timeout

- **ID:** 0220
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `Electron backend command registry > deletes an environment only
  after all three local server kinds exit`
  (`apps/backend/tests/commands-integration.test.ts`).
- **Failure:** exceeded the 5,000 ms test deadline at 5,343.01 ms.
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

## Coordinator launch-defaults review validation — 2026-10-16

Recurred in the full suite for `0d254a3a`; the unchanged owning file passed
separately with one isolated Bun worker. Exact failures, suite counts,
commands, durations and evidence are recorded in
[0255](0255-backend-fixtures-launch-defaults-validation.md).
No assertion, deadline or skip was changed.

## Recurrence during Multi Review follow-up validation (2026-10-16)

- **Aggregate:** `mise run test:logged -- --name full-suite -- mise run test`, with 4/1/2/1 workspace/root/bridge/protocol slots and two backend workers. The unchanged case exceeded five seconds at 5788.09 ms.
- **Owning-file rerun during the aggregate:** `mise run test:logged -- --name commands-integration-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` also timed out in this case (6328.85 ms); the file reported 52 passed and three timed-out tests in 127.9 seconds. Evidence: `/tmp/orkestrator-test-run.3kSG12/commands-integration-rerun.log.gz`.
- **After the aggregate:** the same owning-file command with `--name commands-integration-final-rerun` passed unchanged in 32.1 seconds (exit 0).
- **Aggregate evidence:** `/tmp/orkestrator-test-run.1PZf4j/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No lifecycle implementation, assertion, timeout or skip changed. Host contention remains a hypothesis.

## Observation during storage-read accounting merge (2026-10-16)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Other worktrees were validating
  on the same host; workspace admission waited 286.5 seconds.
- **Suite counts:** backend 8,280 passed, 40 skipped, four failed and one
  between-tests error across 441 files (454.79 seconds). The other workspace
  packages, root, bridges and protocol groups passed. The aggregate exited 1
  after 777.1 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.gwCPHc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.gxKAtN/merge-tests.log.gz`.
- **Failure:** the same local-server deletion case exceeded its five-second
  deadline at 5480.19 ms.
- **Isolated rerun:** `mise run test:logged -- --name merge-commands-integration -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged file in 32.0 seconds (exit 0).
- **Disposition:** recurrence confirmed by the isolated pass; shared-host
  contention remains a hypothesis. No test, timeout or skip was changed.

## Recurrence — 2026-10-16 (live coordinator branch second main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees were validating on the same host.
- **Failure:** `deletes an environment only after all three local server kinds exit` timed out at 5083.07 ms.
- **Suite counts:** backend 8,342 passed, 40 skipped and four failed across 445 files (599.23 seconds). All other workspace packages, root, bridges and protocol passed; aggregate exited 1 after 622.4 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.zOMprl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.TYkzGQ/merge-tests.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-local-server-isolated -- bun test --cwd apps/backend ./tests/commands-integration.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0) in 60.0 seconds. Each owning file ran in its own process; other focused reruns were active on the host.
- **Disposition:** intermittent failure confirmed by the owning-file pass; shared-host contention remains an unconfirmed hypothesis. No product code, assertion, timeout or skip was changed.

## Mobile layout merge validation recurrence — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU host utilities preferred in PATH, on `mobile-layout-gaps` while merging `origin/main`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees and component browser validation were active on the host.
- **Failure:** The deletion case waiting for all three local server kinds timed out at 6701.23 ms against its 5000 ms limit.
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
- **Failure:** `deletes an environment only after all three local server kinds exit` exceeded its 5000 ms budget at 7740.35 ms.
- **Owning-file rerun:** `mise run test:logged -- --name merge-latest-commands-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  with the same GNU-tool PATH passed the entire unchanged owning file (exit 0,
  23.7 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.hmA9t0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.1X6sCk/merge-latest-tests.log.gz`.
- **Disposition:** isolated pass confirms an intermittent recurrence. Host
  contention remains a hypothesis; no implementation, assertion, timeout or
  skip changed.

## Read-only Codex networking validation — 2026-10-17

- **Original command:** `mise run test:logged -- --name all-tests -- mise run test`
  at `f757d022`, with the Codex networking fixes in the working tree.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers. Other worktrees were validating
  on the same host.
- **Failure:** `Electron backend command registry > deletes an environment only
  after all three local server kinds exit` in
  `apps/backend/tests/commands-integration.test.ts` exceeded its 5000 ms limit
  at 5356.05 ms.
- **Owning-file rerun:** `mise run test:logged -- --name backend-deletion-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file in 18.8 seconds (exit 0).
- **Suite counts:** backend 8618 passed, 41 skipped and one failed across
  8660 tests in 461 files (384.25 seconds). The aggregate exited 1 after
  424.8 seconds; it also reported the existing flake-register metadata error
  for case 0265 and a Codex close-route assertion subsequently corrected and
  verified by a passing complete Codex package run.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UC2B1d/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.tSfnBT/all-tests.log.gz`.
- **Disposition:** the isolated pass confirms an intermittent recurrence. Shared
  host contention remains an unconfirmed hypothesis. No backend implementation,
  assertion, deadline or skip changed.
