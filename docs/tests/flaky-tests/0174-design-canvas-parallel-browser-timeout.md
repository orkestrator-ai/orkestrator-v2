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

## Current assessment

The design canvas test appears sensitive to the suite's six-worker parallel load. The design canvas code did not change in this task; investigate the timeout under controlled parallel load.
