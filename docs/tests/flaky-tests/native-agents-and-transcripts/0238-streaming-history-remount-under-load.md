# Measured transcript history loses its row after remount under load

- **ID:** 0238
- **Status:** open
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
