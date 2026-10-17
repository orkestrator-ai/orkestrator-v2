# Pane breakpoint fixtures during parallel browser startup

- **ID:** 0351
- **Status:** open
- **Date observed:** 2026-10-17
- **Test:** `split panes keep terminal output, scroll positions and the draft across the breakpoint`
- **File:** `e2e/PaneBreakpoint.spec.ts:98`
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`
- **Failure:** Three mobile variants failed their unchanged five-second startup
  checks. The pane-tree `moveBefore` and `appendChild fallback` variants found
  zero `.xterm` elements instead of one; the app-shell `moveBefore` variant
  found no `Projects and environments` dialog.
- **Suite result:** 335 passed, 80 skipped, five failed across 420 cases using
  nine browser workers alongside repository tests and other worktrees.
- **Owning-file rerun:** `mise run test:logged -- --name browser-pane-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts --workers=1`
  passed the entire unchanged file (exit 0, 33.8 seconds). Browser owning-file
  reruns ran sequentially, with no shared output-directory collision.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.iMEuX0/browser.log.gz`.

The isolated pass establishes intermittence. Host contention is a hypothesis,
not a confirmed cause. No assertion, timeout, or skip changed.
