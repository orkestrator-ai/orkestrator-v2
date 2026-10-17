# Pane-breakpoint terminal missing during parallel browser startup

- **ID:** 0342
- **Status:** open
- **Date observed:** 2026-10-17
- **Test:** `split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, moveBefore)`
- **Owning file:** `e2e/PaneBreakpoint.spec.ts:98`
- **Original command:** `mise run test:logged -- --name resolve-browser -- mise run test:browser`
- **Workers:** nine Playwright workers, alongside repository and isolated-browser validation on a loaded shared host.
- **Failure:** The mobile project found zero `.xterm` elements instead of one at line 121 after the five-second startup deadline.
- **Suite counts:** 338 passed, 80 skipped, two failed across 420 cases in 291.7 seconds. The other failure matches case 0173.
- **Owning-file rerun:** `mise run test:logged -- --name resolve-browser-owner-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts e2e/PaneBreakpoint.spec.ts --workers=1` passed both unchanged files (exit 0, 42.1 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NgqDST/resolve-browser.log.gz`; passing summary at `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.RQfNTY/summary.json`.
- **Hypothesis:** Terminal initialization missed its deadline under contention. ActionBar view edits also overlapped this initial browser run, so Vite updates may have contributed; neither explanation is confirmed. No pane or terminal code, timeout, assertion or skip changed.
