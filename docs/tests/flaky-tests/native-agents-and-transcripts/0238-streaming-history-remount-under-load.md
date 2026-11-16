# Measured transcript history loses its row after remount under load

- **ID:** 0238
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `[desktop-chromium] › measured history restores before an explicit jump to the latest row`
- **Owning file:** `e2e/StreamingTranscript.spec.ts:157`
- **Original command:** `mise run test:logged -- --name browser-suite -- mise run test:browser -- --workers=2`
  on branch `pr-target-branch-277220bf3f57-r1`, alongside the repository suite
  and isolated browser validation.
- **Failure:** after `Save and remount`, the restored range counter advanced,
  but `[data-chat-message-index="40"]` did not become visible within 5000 ms
  at line 173.
- **Suite counts:** 232 passed, 61 skipped, 1 failed (153.2 s).
- **Isolated owning-file rerun:** `mise run test:logged -- --name streaming-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1`
  passed all twelve cases across the desktop and mobile projects (13.8 s).
- **Evidence:** `/tmp/orkestrator-test-run.pvTtiv/browser-suite.log.gz` and
  its `summary.json`. The subsequent rerun replaced the component browser
  suite's trace directory.
- **Hypothesis:** a remount/measurement timing interaction under host load.
  The current change adds PR base metadata and launch-dialog coverage; it does
  not change transcript scrolling, measurement, or this fixture. The related
  history-anchor case is tracked separately as 0207. No assertions were
  skipped or weakened.

## Resolution (2026-11-15)

- **Root cause:** a default Playwright deadline on a loaded host while waiting on a real signal. Playwright's 5 s default assertion deadline expired on `toBeVisible()` for the restored row 40 after `Save and remount`, a real DOM signal that a loaded host delayed. The spec passes no smaller timeout at that call.
- **Fix:** `e2e/playwright.config.ts` (the component browser suite, `mise run test:browser`) now sets `timeout: 120_000` (was Playwright's 30 s default) and `expect: { timeout: 30_000 }` (was 5 s). Both are hang watchdogs on real signals, not speed checks.
- **Reproduced:** no — the recorded failure was not reproduced before the fix. The evidence is a rerun of the component specs that had failed in a loaded run, with the new config: 112 passed. A raised budget is weaker evidence than a reproduced race.
- **Reopen:** a recurrence that hangs near the new budget (a navigation near 120 s, an assertion near 30 s) means the signal never arrives; reopen this case rather than raising the budget again.
