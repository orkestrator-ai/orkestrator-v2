# Terminal toolbar reload briefly exposes duplicate readiness outputs

- **ID:** 0237
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `[mobile-chromium] › e2e/TerminalCornerToolbar.spec.ts:72 › touch
  history is visible and opens on tap at phone and tablet widths`.
- **Failure:** line 79's `terminal-ready` assertion after `page.reload()`
  resolved to two outputs, both `false`, causing a strict-mode violation.
- **Original command:** `mise run test:logged -- --name coordinator-all-browser --
  mise run test:browser`, nine Playwright workers alongside the non-iOS suite.
  Result: 220 passed, 61 skipped, 1 failed in 63.3 seconds.
- **Isolated rerun:** `mise run test:logged -- --name
  coordinator-browser-terminal-rerun -- mise run test:browser --
  e2e/TerminalCornerToolbar.spec.ts` passed in 7.3 seconds. The owning spec,
  terminal implementation, and terminal fixture were unchanged.
- **Full rerun:** `mise run test:logged -- --name coordinator-browser-final --
  mise run test:browser -- --workers=2` passed in 131.5 seconds (221 passed,
  61 skipped).
- **Evidence:** `/tmp/orkestrator-test-run.BfgDqZ/coordinator-all-browser.log.gz`.
- **Hypothesis:** readiness assertion races fixture replacement during a
  viewport change and reload under load. The isolated pass establishes
  intermittency, not the cause. No assertions were loosened or skipped.
