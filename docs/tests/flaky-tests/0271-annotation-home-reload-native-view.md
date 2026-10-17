# Annotation Home preview hidden after reload

- **ID:** 0271
- **Status:** open
- **Date observed:** 2026-10-17
- **Test:** `Home native preview hides beneath board panels and returns without losing its tab`
  in `e2e/agent-testing/web-annotations-electron.spec.ts`.
- **Original command:** `mise run test:logged -- --name agent-electron -- mise run test:agent:electron`.
  Playwright used one worker; the non-iOS repository suite was also active.
- **Failure:** `visiblePreview` remained false after renderer reload and the
  explicit Home selection; the 30-second poll failed (then line 717).
- **Suite counts:** 3 passed, 2 failed, 1 skipped, 9 did not run. The other
  failure was the separately addressed independent-window focus assertion.
- **Isolated rerun:** `mise run test:logged -- --name annotation-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts`.
  All 10 tests passed in 68.3 seconds. The Home test and its assertions were
  unchanged. Repository validation remained active; the other Electron spec
  briefly ran concurrently during this diagnostic rerun.
- **Evidence:** failure log
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.MX48PV/agent-electron.log.gz`;
  rerun counts in `output/agent-testing/electron-smoke/electron/results.json`.
- **Hypothesis:** asynchronous renderer initialization may overwrite the explicit
  Home selection immediately after `waitForApi`; not confirmed. No timeout or
  assertion was relaxed, and no test was skipped.
