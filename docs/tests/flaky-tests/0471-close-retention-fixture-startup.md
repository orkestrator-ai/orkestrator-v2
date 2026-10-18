# Close-retention fixture misses its startup control under parallel load

- **ID:** 0471
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `closing a Grok tab keeps the conversation; resume restores it and the next prompt continues it`
- **Owning file:** `e2e/CloseRetention.spec.ts:264`
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser` (nine workers).
- **Failure:** the desktop case could not find the `New agent tab` button at the five-second `toBeEnabled` deadline while its fixture navigation finished.
- **Suite counts:** 348 passed, 80 skipped, four failed across 432 cases, 329.2 s logged. Other failures matched the Monaco and pane startup cases 0173 and 0351.
- **Owning-file rerun:** `mise run test:logged -- --name browser-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts e2e/PaneBreakpoint.spec.ts e2e/CloseRetention.spec.ts --workers=1` passed the unchanged files sequentially (exit 0, 96.6 s logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.kKsMFU/browser.log.gz` and `output/playwright/test-results/` on the observing host (the rerun may replace the latter).
- **Hypothesis:** fixture and renderer startup exceeded the short default assertion deadline under concurrent worktree/browser load (host load about 47). Unconfirmed; no assertion or timeout changed.
