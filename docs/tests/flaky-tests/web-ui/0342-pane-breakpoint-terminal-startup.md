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

## Command-node review validation recurrence — 2026-10-21

- `ORKESTRATOR_E2E_PORT=45673 ORKESTRATOR_PUBLIC_E2E_PORT=45674 mise run test:logged -- --name review-browser-confirm -- mise run test:browser` reported 369 passed, 80 skipped, and three failures in 414.1 seconds while repository and isolated browser validation also ran.
- This unchanged owning file failed at its existing deadline. All three unchanged owners then passed sequentially with one worker: `ORKESTRATOR_E2E_PORT=45673 ORKESTRATOR_PUBLIC_E2E_PORT=45674 mise run test:logged -- --name review-browser-three-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts e2e/DesignCanvas.spec.ts e2e/MonacoRuntime.spec.ts --workers=1` (exit 0, 85.5 seconds).
- Evidence: private compressed logs under the host temporary directory `orkestrator-test-run.tj4puK`. The pane case found no `.xterm` at line 121; the desktop canvas exceeded 30 seconds; the desktop Monaco fixture found no editor within five seconds.
- Host scheduling or fixture startup contention is a hypothesis. No implementation, assertion, deadline, or skip in these owners changed.


## Agent accounts main merge — 2026-10-24

`mise run test:logged -- --name merge-browser-fixed -- mise run test:browser`
(nine workers) reported 577 passed, 102 skipped and seven failed in 694.4 s.
The complete unchanged owner passed in the sequential one-worker command
`mise run test:logged -- --name merge-browser-owners -- bunx playwright test --config e2e/playwright.config.ts AgentUsage.spec.ts DesignCanvas.spec.ts PaneBreakpoint.spec.ts AgentLaunchDialog.spec.ts MonacoRuntime.spec.ts VirtuosoFollow.spec.ts --workers=1`.
That combined command reported twenty passed, four skipped and two failures
(127.0 s), both in AgentLaunchDialog; this owner had no failures. Evidence:
`orkestrator-test-run.BIyzun/merge-browser-fixed.log.gz` and
`orkestrator-test-run.ngoXeT/merge-browser-owners.log.gz` below the host temporary
directory. No assertion, timeout, skip or implementation changed in this owner.

Mobile pane-tree moveBefore found zero terminals at its five-second deadline.

## Environment-list UI main merge — 2026-10-24

The aggregate recurrence passed in the complete unchanged owning-file rerun. Exact commands, durations, merge parents, aggregate results and evidence are retained in [0790](../aggregate-validation-runs/0790-environment-list-main-merge-validation.md). No implementation, assertion, timeout or skip changed.


## Resume cleanup coverage validation — 2026-10-25

The mobile pane-tree/moveBefore case found no terminal at the five-second startup deadline in the five-worker component run. All unchanged owner cases passed in the sequential one-worker rerun.

The original component run reported 734 passed, 102 skipped and six failed. The six complete owning files ran sequentially with one worker: 80 passed, one skipped and three failed (307.4 s). Exact commands, per-owner results and artifact paths are in [0822](../aggregate-validation-runs/0822-resume-cleanup-coverage-validation.md). No owning implementation, assertion, deadline or skip changed.
