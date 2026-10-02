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
