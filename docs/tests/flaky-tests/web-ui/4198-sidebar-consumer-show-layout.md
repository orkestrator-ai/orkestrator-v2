# Sidebar consumer show layout count

- **ID:** 4198
- **Status:** open
- **Date observed:** 2026-11-04
- **Tests:** `the sidebar’s animated width lays out a real terminal and editor at most twice`
- **File:** `e2e/agent-testing/sidebar-width-consumers.spec.ts`

Original command: `ORKESTRATOR_AGENT_TEST_PROFILE=agent-sidebar-round3 mise run test:logged -- --name sidebar-real-consumers -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/sidebar-width-consumers.spec.ts --workers=1`.
One worker, 0 passed / 1 failed in 29.2 seconds. The show transition reported
three terminal widths where at most two were expected. Evidence:
`/tmp/orkestrator-test-run.ndFA5o/sidebar-real-consumers.log.gz`.

The unchanged owning-file rerun with the identical command passed 1 / 1 in
31.0 seconds. Assertions were not relaxed. A fixture-browser suite was also
running during the original failure; the source of the third layout is not
established. Keep the two-layout bound and investigate recurrence.
