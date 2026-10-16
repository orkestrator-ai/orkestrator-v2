# Design canvas times out in the parallel browser suite

- **ID:** 0174
- **Status:** open
- **Date observed:** 2026-09-28
- **Test:** `canvas edits, script isolation, missed events, conflict and reload`
- **File:** `e2e/DesignCanvas.spec.ts:16`
- **Original command:** `mise run test:logged -- --name markdown-browser-suite -- mise run test:browser` (150 tests, six Playwright workers), while the repository suite and other worktrees were running.
- **Failure:** The mobile case reached its 30-second deadline while clicking; the desktop case reached the same deadline while reloading.
- **Isolated rerun:** `mise run test:logged -- --name browser-design-canvas-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1` passed.
- **Second parallel run:** The same full browser command failed both mobile and desktop cases again; the other 99 runnable tests passed, including the new Markdown editor test and the diff viewer cases.
- **Additional run:** Another six-worker browser run timed out in both cases while the repository suite ran on the host; 97 passed, 48 skipped, and 5 failed across 150 cases. The mobile case timed out clicking `Switch tab`, and the desktop case lost its iframe session waiting for `Changed while away`. The owning file passed with two workers. A later browser suite run without the repository suite still timed out in both cases while clicking `Switch tab`; 100 passed, 48 skipped, and 2 failed.
- **2026-09-30 recurrence:** `mise run test:logged -- --name browser -- mise run test:browser` ran 152 cases with six workers while the repository suite was running: 101 passed, 49 skipped, and these two cases failed at the 30-second deadline. The mobile case timed out dispatching the reconnect event at line 206; the desktop case lost its iframe session waiting for `Changed while away` after reload at line 211. Failure evidence: `/tmp/orkestrator-test-run.aD2Vci/browser.log.gz`. `mise run test:logged -- --name design-canvas-recheck -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1` passed both cases (32.1 seconds including runner/server startup). The design canvas code was unchanged; this remains consistent with sensitivity to parallel load.

## Current assessment

The design canvas test appears sensitive to the suite's six-worker parallel load. The design canvas code did not change in this task; investigate the timeout under controlled parallel load.


## Mobile layout follow-up main merge recurrence — 2026-10-16

- **Original command:** `ORKESTRATOR_E2E_PORT=52464 CI=1 mise run test:logged -- --name merge-latest-browser -- mise run test:browser`
  while merging `origin/main` into `mobile-layout-gaps`.
- **Worker configuration:** nine Playwright workers alongside the repository
  suite and other validations on the shared host.
- **Suite counts:** 310 passed, 69 skipped and three failed across 382 cases
  (5.2 minutes). The other failures are recorded in 0173.
- **Failure:** The desktop case `canvas edits, script isolation, missed events, conflict and reload` exhausted its 30000 ms budget at `page.reload()` (line 190).
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=52464 CI=1 mise run test:logged -- --name merge-latest-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/DiffViewerMobile.spec.ts --workers=1`
  passed both unchanged owning files (exit 0, 51.6 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.r2KR91/merge-latest-browser.log.gz`.
- **Disposition:** parallel-only recurrence matching the existing case. Host
  contention remains a hypothesis; no assertion, timeout or skip changed.
