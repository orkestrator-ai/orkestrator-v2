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
