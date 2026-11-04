# Coordinator activity browser fixture startup

Renumbered from 4043 to 4311 to preserve the HTML preview case on main.

- **ID:** 4311
- **Status:** open
- **Date observed:** 2026-11-04

In `e2e/CoordinatorActivity.spec.ts` (desktop Chromium), `a coordinator's activity shows on its tab and its project heading` and `the tab's spinner follows its outline, unclipped, on the shared timeline` timed out waiting for the coordinator working outline (5 seconds). The tests were unchanged by this focus repair.

Original command: `mise run test:logged -- --name focus-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/FocusVisibility.spec.ts e2e/GlobalStyles.spec.ts e2e/WorkspaceBarHeight.spec.ts e2e/CoordinatorActivity.spec.ts --workers=4`. Result: 57 passed, 7 skipped, 2 failed, 36.9 seconds. Evidence: `/tmp/orkestrator-test-run.ODyaFS/focus-browser.log.gz`.

Owning-file isolated rerun: `mise run test:logged -- --name coordinator-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/CoordinatorActivity.spec.ts --project=desktop-chromium --workers=1`. Exit 0, 24.8 seconds. No assertions were relaxed or tests skipped to obtain the passing rerun. A cold fixture load under parallelism is a hypothesis; the underlying cause remains unconfirmed.

The original four-worker command later passed unchanged (33.3 seconds). An intervening attempt overlapped another component-browser invocation using the same output directory and fixture server, producing trace-file ENOENT and connection failures; that attempt is infrastructure interference, not additional evidence of this flake.
