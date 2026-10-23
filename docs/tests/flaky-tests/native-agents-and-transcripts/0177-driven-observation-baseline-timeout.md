# driven native observation baseline (step 07) > is deterministic, content-free, and sharing drops reads without losing edges

- **ID:** 0177
- **Status:** open
- **Date observed:** 2026-10-02
- **Test:** `driven native observation baseline (step 07) > is deterministic, content-free, and sharing drops reads without losing edges`
- **File:** `apps/backend/tests/recurring-baseline.test.ts:94`
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`
- **Worker configuration:** Workspace group 2 slots, one Bun worker per package;
  root group 3 workers, bridges 2 slots, protocol 1 slot. Isolated browser
  validation also ran on the host.
- **Failure:** The case exceeded Bun's 5000 ms timeout (5000.09 ms).
- **Suite counts:** The workspace group failed; backend package completion counts were unavailable when Turbo stopped it after the web package failed.
- **Isolated rerun:** `mise run test:logged -- --name baseline-observation -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/recurring-baseline.test.ts --parallel=1 --only-failures`
- **Rerun result:** All 5 tests passed in the isolated file; logged command completed in 6.0 s.
- **Hypothesis:** The scenario drives backend activity and child processes. Concurrent package, root, bridge, and browser validation may exhaust the five-second case budget; the precise cause is unconfirmed.
- **Failure artifact:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.mTizZb/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`

Observed while validating AddProjectDialog remote detection. No code in the
owning area changed, and no test was skipped or loosened.

## Recurrence — 2026-10-12

Observed while validating Claude retained-runtime fencing. The owning backend
code was unchanged.

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`,
  with the testing guide's macOS GNU-tool PATH.
- **Workers:** workspace two slots (one Bun worker per package), root three,
  bridges two, protocol one. A focused Claude bridge package run also ran.
- **Failure:** the same case exceeded 5000 ms (5021.03 ms).
- **Suite counts:** backend 5772 pass, 15 skip, 2 fail, 1 unhandled error;
  5789 tests across 323 files. The other failed case was flake 0189.
- **Isolated rerun:** `mise run test:logged -- --name recurring-baseline-isolated -- bun test --cwd apps/backend ./tests/recurring-baseline.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed, exit 0 (6.0 s).
- **Evidence:** `/tmp/orkestrator-test-run.3FTW4U/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** consistent with the existing concurrent-load timeout; the
  isolated pass does not identify which operation consumed the budget. No
  timeout, assertion or skip changed.

## Design live-cycle second main merge — 2026-10-18

The GNU-tool PATH `mise run test:logged -- --name merge-full -- mise run test` (workspace/root/bridges/protocol reservations 4/1/2/1, alongside browser validation) timed out `driven native observation baseline (step 07) > is deterministic, content-free, and sharing drops reads without losing edges` at 5056.63 ms. The unchanged owning file passed `mise run test:logged -- --name merge-unit-owner-recurring-baseline -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/recurring-baseline.test.ts --parallel=1 --only-failures`, exit 0, in 14.6 seconds logged. Aggregate evidence: `orkestrator-test-run.yluX61/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Confirmed intermittent recurrence; no implementation, assertion, timeout or skip changed.

## CLI matrices second main merge observation — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge2-tests -- mise run test`, macOS arm64, Bun 1.4.3; workspace/root/bridges/protocol reservations 4/1/2/1 alongside component and isolated browser validation.
- **Failure:** the same deterministic-baseline case exceeded 5000 ms (5001.88 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge2-recurring-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/recurring-baseline.test.ts --parallel=1 --only-failures` also timed out (5000.10 ms; four passed, one failed; 25.7 seconds logged). An earlier three-file one-worker rerun repeated it at 5002.03 ms.
- **Evidence:** `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`, `orkestrator-test-run.FpMEz2/merge2-recurring-owner.log.gz`, and `orkestrator-test-run.okcKbq/merge2-backend-owners.log.gz` under the host temporary directory.
- **Assessment:** unresolved in this observation because the unchanged owning file failed alone too. No owning code, assertion, timeout or skip changed.

Aggregate result: `merge2-tests` exited 1 after 1132.1 seconds logged. Backend reported 9081 passed, 41 skipped and 11 failed across 9133 tests in 485 files (1118.57 seconds). Every other workspace package passed; root/support passed 3084 tests with one skip, and protocol regeneration passed. Evidence: `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.

After the full aggregate ended, `mise run test:logged -- --name merge2-after-aggregate-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts ./tests/recurring-baseline.test.ts --parallel=1 --only-failures` reported 56 passed, one failed and one between-test error across 57 tests (56.0 seconds logged). All five unchanged recurring-baseline tests passed; coordinator bound-discard still timed out (5279.64 ms), with late `SQLITE_IOERR_VNODE`. Evidence: `orkestrator-test-run.zR2pum/merge2-after-aggregate-owners.log.gz` below the host temporary directory. This confirms intermittence for the baseline case while leaving the coordinator observation unresolved.


## Cross-service preview review follow-up — 2026-10-23

- **Original command:** `mise run test:logged -- --name preview-review-full -- mise run test`
  on macOS 27.0 arm64, Bun 1.4.3; workspace/root/bridges/protocol reservations
  4/1/2/1. The workspace waited 510.3 seconds for host capacity before execution.
- **Failure:** the same deterministic-baseline case exceeded the unchanged
  5000 ms timeout (5464.85 ms).
- **Suite counts:** backend 9553 passed, 61 skipped, one failed across 9615
  tests and 542 files (359.23 seconds). Every other workspace task and the
  root/support, bridge and protocol groups passed. Aggregate: exit 1,
  938.4 seconds logged.
- **Owning-file rerun:** `mise run test:logged -- --name recurring-baseline-isolated -- bun test --cwd apps/backend ./tests/recurring-baseline.test.ts --parallel=1 --only-failures`
  also timed out (5562.65 ms): four passed, one failed, 66 assertions,
  12.3 seconds logged.
- **Evidence:** `orkestrator-test-run.RWMU2X/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and `orkestrator-test-run.X4PQFk/recurring-baseline-isolated.log.gz`, under
  the host temporary directory; outer aggregate evidence in
  `orkestrator-test-run.m8U5Rl/preview-review-full.log.gz`.
- **Assessment:** unresolved in this run because the owner failed alone too;
  the isolated result does not establish a new intermittent recurrence.
  Existing evidence already tracks this timeout, including isolated failures.
  Concurrent host load is plausible but unproven. This preview change does
  not alter the baseline owner, its harness, assertion, timeout or skips.
