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
