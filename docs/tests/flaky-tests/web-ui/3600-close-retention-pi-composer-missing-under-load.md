# Close-retention Pi case never shows its composer under host load

- **ID:** 3600
- **Status:** open
- **Date observed:** 2026-11-03
- **Test:** `closing a Pi tab keeps the conversation; resume restores it and the next prompt continues it` (desktop Chromium)
- **Owning file:** `e2e/CloseRetention.spec.ts:328`
- **Change under test:** to-do 2921 task 3 on branch `close-retention-cases-4142aaf8cd0b-r1`
  (based on `main` at `7b48c23fb`). It changes the Cursor fake engine
  (`bridges/cursor-bridge/src/testing/fake-engine-server.ts`), the
  close-retention host's Cursor vendor view and Cursor-only spec lines; nothing
  on the Pi path.
- **Original command:** `CI=1 ORKESTRATOR_E2E_PORT=1537 mise run test:logged -- --name close-retention-all -- bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts`
  (Playwright's default workers, both projects).
- **Failure:** `locator.fill: Test timeout of 120000ms exceeded`, waiting for
  `getByRole('textbox', { name: 'Message Pi' })` in the first `completeTurn`
  (spec line 338, `send` at line 189). `openEnvironment` had already returned.
- **Suite counts:** 19 passed, 20 skipped, 1 failed (3.1 min). The mobile run of
  the same case passed.
- **Isolated rerun:** `CI=1 ORKESTRATOR_E2E_PORT=1537 mise run test:logged -- --name close-retention-pi-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts --project desktop-chromium --grep "closing a Pi tab keeps" --repeat-each 2`
  passed both repetitions (41.8 s).
- **Host:** beelink with about ten concurrent builds; load average 71.6 (1 min)
  just after the failing run.
- **Evidence:** `/tmp/orkestrator-test-run.s4tlvf/close-retention-all.log.gz` on
  the observing host. The isolated rerun replaced the failing case's
  `error-context.md`, so the page snapshot at the failure was not kept.
- **Hypothesis:** the Pi tab's composer depends on the Pi bridge answering its
  first snapshot, and under this load the bridge or renderer did not get there
  within the case's budget. Not confirmed; no assertion, timeout or skip
  changed. Compare [0471](0471-close-retention-fixture-startup.md), the Grok
  startup-control miss in the same file.
