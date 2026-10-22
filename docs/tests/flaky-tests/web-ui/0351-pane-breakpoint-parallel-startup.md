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

## Preview path provenance validation — 2026-10-18

`mise run test:logged -- --name browser -- mise run test:browser` ran 432
cases with nine workers: 348 passed, 80 skipped and four failed in 329.2 s.
Both pane-tree variants (`moveBefore` and `appendChild fallback`) found zero `.xterm` elements at the five-second startup assertion.
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.kKsMFU/browser.log.gz`.

The unchanged owning files passed sequentially with one worker:
`mise run test:logged -- --name browser-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts e2e/PaneBreakpoint.spec.ts e2e/CloseRetention.spec.ts --workers=1`
(exit 0, 96.6 s logged). Other worktrees and real-stack checks were active on
the host. Startup contention remains an unconfirmed hypothesis; no assertion
or timeout changed.

## Landing-page main merge recurrence — 2026-10-18

`ORKESTRATOR_E2E_PORT=49295 ORKESTRATOR_PUBLIC_E2E_PORT=49296 mise run test:logged -- --name merge-browser-isolated-ports -- mise run test:browser` reported 303 passed, 80 skipped and 49 failed with nine workers alongside other host validation. This owner failed in:

- `split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, appendChild fallback)`
- `split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, moveBefore)`
- `split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, moveBefore)`

All 21 failing owners, including this unchanged file, passed with one worker in 428.8 seconds (exit 0). The complete rerun command, individual failure messages and evidence paths are in [0382](0382-component-browser-parallel-load.md). No timeout, assertion, skip or owning source changed.

## Async question prefix review recurrence — 2026-10-18

The nine-worker component suite again found zero terminal elements at the
five-second startup deadline in both mobile pane-tree variants. The suite
reported 357 passed, 80 skipped and three failed (283.1 seconds logged).
Both unchanged owning files passed sequentially with one worker in 35.4 seconds.
Commands and the aggregate evidence path are recorded in
[0173](0173-diff-viewer-parallel-monaco-startup.md#async-question-prefix-review-recurrence--2026-10-18).
No assertion, timeout or skip changed.

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](../aggregate-validation-runs/0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.
