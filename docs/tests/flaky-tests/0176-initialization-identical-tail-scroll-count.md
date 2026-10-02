# InitializationLogs > identical tails write no state: no re-render, no re-scroll

- **ID:** 0176
- **Status:** open
- **Date observed:** 2026-10-02
- **Test:** `InitializationLogs > identical tails write no state: no re-render, no re-scroll`
- **File:** `apps/web/src/components/terminal/InitializationLogs.test.tsx:137`
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`
- **Worker configuration:** Workspace group 2 slots, one Bun worker per package;
  root group 3 workers, bridges 2 slots, protocol 1 slot. Isolated browser
  validation also ran on the host.
- **Failure:** The scroll-count assertion expected 0 calls but received 1 at line 146 (29.90 ms).
- **Suite counts:** 8091 passed, 11 skipped, 2 failed across 415 web files (217.84 s).
- **Isolated rerun:** `mise run test:logged -- --name baseline-initialization -- bun test --cwd apps/web ./src/components/terminal/InitializationLogs.test.tsx --parallel=1 --only-failures`
- **Rerun result:** 10 tests passed in the isolated file; logged command completed in 0.2 s.
- **Hypothesis:** The test captures the scroll count after the text appears, before the initial scrolling effect necessarily runs. Aggregate scheduling may let that first scroll occur during the identical-tail polling checks; the precise cause is unconfirmed.
- **Failure artifact:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.mTizZb/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`

Observed while validating AddProjectDialog remote detection. No code in the
owning area changed, and no test was skipped or loosened.
