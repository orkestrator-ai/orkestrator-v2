# Public API restart receipt fixture cleanup hits EPERM

- **ID:** 0261
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `request keys and receipts > a replay after a restart returns the original receipt without re-executing`
- **File:** `apps/backend/src/core/public-api/public-api-projects.test.ts:185`
- **Original command:** `mise run test:logged -- --name final-tests -- mise run test`. The aggregate used four workspace slots (two workers per package), one root worker, two bridge slots, and one protocol slot.
- **Failure:** Fixture cleanup at `public-api/test-support.ts:143` threw `EPERM: operation not permitted, rm '/tmp/ork-public-api-…'` after the replay assertions. The case took 11.04 ms. The backend package reported 8,098 pass, 40 skip, 3 fail, and 40,462 assertions across 440 files in 275.12 seconds.
- **Isolated rerun:** `mise run test:logged -- --name public-api-isolated -- bun test --cwd apps/backend ./src/core/public-api/public-api-projects.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (exit 0, 3.2 seconds).

## Current assessment

The unchanged owning file passes alone. The failure is in recursive temporary-directory removal rather than receipt replay. Concurrent fixture teardown or host filesystem activity may explain the transient permission error; the evidence does not establish which. No cleanup assertion, timeout, or production public API behavior was changed.

The subsequent settled-snapshot aggregate (`stable-final-tests`) did not reproduce this failure; its backend failures were the existing preview-tunnel flake and the unchanged HTTP provider module-size boundary.

## Annotation sign-off main merge recurrence (2026-10-17)

- **Command:** `mise run test:logged -- --name merge-tests -- mise run test`,
  using four workspace slots, one root slot, two bridge slots and one protocol
  slot (the standard aggregate allocation).
- **Failure:** The same replay test reached fixture cleanup and failed at
  `public-api/test-support.ts:143` with `EPERM` removing its temporary root
  (9.67 ms). Backend: 8,732 passed, 41 skipped, one failed across 468 files
  in 260.15 seconds. All other packages and groups passed; aggregate 294.8 s.
- **Isolated rerun:** `mise run test:logged -- --name merge-public-api-projects -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-projects.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0, 2.0 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.KySnXI/`
  and `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ibpcag/`.
- **Assessment:** Recurrence of the registered cleanup flake; the isolated
  pass still does not establish which concurrent filesystem activity caused it.

The subsequent full confirmation run,
`mise run test:logged -- --name merge-tests-confirm -- mise run test`,
passed all four groups (exit 0, 282.3 seconds).

## OpenCode and Pi access-only logins recurrence (2026-10-21)

- **Command:** `mise run test` (standard aggregate allocation), on a heavily
  loaded host with other worktrees validating.
- **Failure:** The same replay test failed at `public-api/test-support.ts:143`
  with `EPERM` removing `/tmp/ork-public-api-…` (8.10 ms). The run's only
  other failure was a coverage-test stub that this change needed and was
  fixed.
- **Isolated rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-projects.test.ts`
  passed unchanged (25 pass, 3.2 seconds).
- **Assessment:** Recurrence of the registered cleanup flake; cause still
  unestablished.

## Federated client latest-main warm run — 2026-10-21

- **Command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name refresh-main-warm-tests -- mise run test`, merging `3da8e0cf` into pre-merge HEAD `8e695b7d`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; the backend used two isolated workers. A separate gateway owning-file check ran alongside the beginning of the suite.
- **Failure:** the replay case completed its receipt assertions, then fixture cleanup at `public-api/test-support.ts:143` raised `EPERM` removing the temporary root (9.29 ms). The backend source and owning test were unchanged.
- **Counts:** backend 9,897 passed, 68 skipped, one failed across 9,966 tests in 569 files (468.26 s). All other packages, root/support, bridges and protocol passed. The aggregate exited 1 after 490.4 seconds.
- **Owning-file rerun:** `mise run test:logged -- --name refresh-main-receipt-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-projects.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 2.7 seconds.
- **Evidence:** `orkestrator-test-run.Xoy0uL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer artifact `orkestrator-test-run.520NxN/refresh-main-warm-tests.log.gz`.
- **Assessment:** confirmed recurrence of the fixture-cleanup flake. Concurrent filesystem activity remains an unconfirmed hypothesis; no implementation, assertion, timeout or skip changed.

## Lifecycle error-context coverage validation — 2026-10-21

- **Command:** `mise run test:logged -- --name full-suite -- mise run test` at `5442a172b` plus renderer regression tests. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers.
- **Failure:** the same replay case failed during fixture cleanup at `public-api/test-support.ts:143`, with `EPERM` removing its temporary root (9.75 ms).
- **Counts:** backend 9,897 passed, 68 skipped, one failed across 9,966 tests in 569 files (368.71 s). The aggregate exited 1 after 435.3 seconds; the other failure was the desktop shutdown timing flake in case 0350. Root/support, bridges and protocol passed.
- **Owning-file rerun:** `mise run test:logged -- --name public-api-projects-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-projects.test.ts --parallel=1 --only-failures` passed unchanged, exit 0 in 2.7 seconds.
- **Evidence:** `orkestrator-test-run.7BXWb1/full-suite.log.gz` and `orkestrator-test-run.wdkpxS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** recurrence of the recorded cleanup flake; concurrent filesystem activity remains an unconfirmed hypothesis. No implementation, assertions, timeouts or skips changed in this owner.
