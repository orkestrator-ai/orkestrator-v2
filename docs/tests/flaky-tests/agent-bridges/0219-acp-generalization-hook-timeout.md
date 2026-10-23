# ACP generalization hook timeout

- **ID:** 0219
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `ACP protocol generalization > serves filesystem and bounded terminal
  requests from the fake agent`
  (`bridges/acp-bridge/src/acp-generalization.test.ts:60`).
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name merge-main-full-suite -- mise run test`.
- **Worker configuration:** bridge package `--parallel=1`; Turbo runs up to two
  bridge packages concurrently under the shared host-capacity scheduler.
  Other worktree validations were active on the host.
- **Failure:** Bun reported `a beforeEach/afterEach hook timed out for this test`
  after 60,007.87 ms.
- **Failure evidence:** `/tmp/orkestrator-test-run.jDL6Dp/bridges.log`.
- **Suite counts:** ACP 499 passed, 3 skipped, 1 failed across 503 tests in
  32 files (140.13 seconds). Four of five bridge package tasks passed.
- **Isolated rerun:** `mise run test:logged -- --name acp-generalization-isolated
  -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts
  ./src/acp-generalization.test.ts --parallel=1 --only-failures` passed unchanged
  in 0.5 seconds (3 tests).
- **Hypothesis:** the failure is in a shared fixture lifecycle hook under
  aggregate load. The isolated pass does not identify which hook operation
  consumed the budget; no product defect has been established.
- **Disposition:** recorded without skipping, loosening, or changing the test.

- **Package rerun:** `mise run test:logged -- --name acp-bridge-recheck --
  bun run --cwd bridges/acp-bridge test:bridge` passed unchanged in
  107.4 seconds.

## Recurrence on 2026-10-16 during the storage writer guards merge

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** ACP `--parallel=1`, up to two bridge packages in
  Turbo, with other worktree validations active on the shared host.
- **Failure:** the same test at `acp-generalization.test.ts:60` reported
  `a beforeEach/afterEach hook timed out for this test` after 60,003.57 ms.
- **Suite counts:** ACP 567 passed, 3 skipped, 1 failed across 571 tests in
  36 files (148.66 seconds); the other four bridge package tasks passed.
- **Evidence:** `/tmp/orkestrator-test-run.Q27xqQ/bridges.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-acp-isolated --
  bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts
  ./src/acp-generalization.test.ts --parallel=1 --only-failures` passed unchanged
  (3 tests; logged command 0.9 seconds).
- **Hypothesis:** consistent with the existing shared-fixture cleanup timeout
  under aggregate load. No test or product code was changed for this recurrence.

## Recurrence — 2026-10-16 (temporary host port main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`,
  using the testing guide's GNU-tool PATH. Workspace/root/bridges/protocol
  reserved 4/1/2/1 slots; component browser validation ran alongside it.
- **Failure:** the fixture hook timed out at 60008.13 ms in
  `ACP protocol generalization > serves filesystem and bounded terminal requests from the fake agent`.
- **Suite counts:** ACP 574 passed, three skipped and one failed across
  578 tests in 37 files (167.06 s); the other four bridge packages passed.
- **Isolated rerun:** `mise run test:logged -- --name merge-acp-generalization-isolated -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-generalization.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0, 0.4 s).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.MTrBXO/bridges.log.gz`.
- **Disposition:** confirms an intermittent recurrence; the existing fixture
  contention hypothesis remains unconfirmed. No assertion, timeout or skip changed.


## Main merge recurrence — 2026-10-18

- **Command:** `mise run test:logged -- --name merge-15f6cd-acp-rerun -- bun run --cwd bridges/acp-bridge test:bridge`, one isolated Bun worker.
- **Failure:** the same hook exceeded 60004.23 ms; ACP reported 622 passed, 3 skipped and 2 failed across 627 tests.
- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-acp-owners -- bun test --cwd bridges/acp-bridge ./src/acp-http.test.ts ./src/acp-generalization.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 6.6 seconds.
- **Evidence:** `orkestrator-test-run.KPQz1y/merge-15f6cd-acp-rerun.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence; no timeout, assertion or skip changed.

## Structured review layout validation recurrence — 2026-10-21

- **Command:** `mise run test:logged -- --name complete-tests -- mise run test`.
- **Workers:** ACP `--parallel=1`, two bridge packages under Turbo; aggregate
  groups reserved 4/1/2/1 workspace/root/bridge/protocol slots. Browser checks
  and another worktree's validation were active on the host.
- **Failure:** the filesystem/terminal fixture hook timed out at 60009.03 ms.
  ACP reported 646 passed, 3 skipped, 1 failed across 650 tests in 43 files
  (263.61 s); the other four bridge package tasks passed.
- **Evidence:** `orkestrator-test-run.RzbPLB/bridges.log.gz` under the host
  temporary directory.
- **Owning-file rerun:** `mise run test:logged -- --name acp-generalization-rerun -- bun --cwd=bridges/acp-bridge test ./src/acp-generalization.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed unchanged (3 tests, exit 0, 1.2 s logged).
- **Assessment:** confirms the existing intermittent fixture lifecycle timeout.
  Shared-host contention remains a hypothesis; no assertion, timeout or skip changed.

## Two-column report main merge — 2026-10-21

ACP filesystem/terminal generalization hit its 60-second hook deadline (60,013.01 ms); its complete unchanged owner passed with the Node preload in 1.6 seconds (`merge-acp-owner`). See [0629](../aggregate-validation-runs/0629-two-column-main-merge-validation.md) for commands, worker configuration, counts and evidence. No source, assertion, timeout or skip changed.

## Released Claude wakeup validation — 2026-10-23

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1, one ACP worker, alongside isolated browser validation and other worktrees.
- **Failure:** the same filesystem/terminal test's fixture hook timed out at 60007.83 ms. ACP reported 654 passed, 3 skipped, 1 failed across 44 files (293.14 s).
- **Unchanged owner:** `mise run test:logged -- --name acp-generalization-node -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-generalization.test.ts --parallel=1 --only-failures` passed (exit 0, 1.9 s logged).
- **Evidence:** `orkestrator-test-run.XHMi6K/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent fixture lifecycle timeout; shared-host contention remains a hypothesis. No assertion, timeout or skip changed.
