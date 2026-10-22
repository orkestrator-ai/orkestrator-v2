# Monaco runtime fixture startup deadline

- **ID:** 0517
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `real Monaco defaults and every Vite worker route initialize in Chromium`
- **File:** `e2e/MonacoRuntime.spec.ts:3`
- **Failure:** the desktop fixture's `.monaco-editor` was absent at the five-second deadline (line 25).

## Command-node review validation recurrence — 2026-10-21

- `ORKESTRATOR_E2E_PORT=45673 ORKESTRATOR_PUBLIC_E2E_PORT=45674 mise run test:logged -- --name review-browser-confirm -- mise run test:browser` reported 369 passed, 80 skipped, and three failures in 414.1 seconds while repository and isolated browser validation also ran.
- This unchanged owning file failed at its existing deadline. All three unchanged owners then passed sequentially with one worker: `ORKESTRATOR_E2E_PORT=45673 ORKESTRATOR_PUBLIC_E2E_PORT=45674 mise run test:logged -- --name review-browser-three-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts e2e/DesignCanvas.spec.ts e2e/MonacoRuntime.spec.ts --workers=1` (exit 0, 85.5 seconds).
- Evidence: private compressed logs under the host temporary directory `orkestrator-test-run.tj4puK`. The pane case found no `.xterm` at line 121; the desktop canvas exceeded 30 seconds; the desktop Monaco fixture found no editor within five seconds.
- Host scheduling or fixture startup contention is a hypothesis. No implementation, assertion, deadline, or skip in these owners changed.

## Transcript-scroll main merge validation — 2026-10-21

- `mise run test:logged -- --name merge-browser -- mise run test:browser` ran nine workers and reported 373 passed, 81 skipped and two failures in 427.3 s. The desktop Monaco editor was absent at the five-second deadline (`e2e/MonacoRuntime.spec.ts:25`).
- The same unchanged owner failed both the one-worker combined rerun with DesignCanvas (36.4 s logged, one pass/one failure) and `mise run test:logged -- --name merge-monaco-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/MonacoRuntime.spec.ts --project=desktop-chromium --workers=1` (one failure, 20.2 s logged). Those focused reruns still failed at the same deadline.
- Evidence: host temporary directories `orkestrator-test-run.2Itj5O`, `orkestrator-test-run.SL0qW8` and `orkestrator-test-run.PRdnBF`. No source, assertion, timeout or skip changed.
- After the complete aggregate ended, the unchanged owner passed: `mise run test:logged -- --name merge-monaco-after-aggregate -- bunx playwright test --config e2e/playwright.config.ts e2e/MonacoRuntime.spec.ts --project=desktop-chromium --workers=1` (exit 0, 3.9 s logged). Shared-host or startup contention remains a hypothesis.

## Sidebar main-merge validation — 2026-10-22

- `mise run test:logged -- --name merge-browser -- mise run test:browser` ran nine workers against the initial `c17f1c8d5` merge: 399 passed, 81 skipped, two failed (362.5 s). The desktop editor was absent at the five-second deadline at line 25.
- After refreshing the pending merge to `7e051d955`, `mise run test:logged -- --name merge-monaco-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/MonacoRuntime.spec.ts --workers=1` passed the complete unchanged owner, exit 0 in 4.0 s.
- Evidence: `orkestrator-test-run.mgE8Fb/merge-browser.log.gz` under the host temporary directory. No assertion, deadline or skip changed; startup or host contention remains a hypothesis.


## Repository-sidebar review validation — 2026-10-22

- **Original command:** `mise run test:logged -- --name browser-suite -- mise run test:browser`, nine workers alongside repository validation on the shared host. The component suite reported 437 passed, 85 skipped and four failed in 9.4 minutes. The desktop Monaco editor was absent at the existing five-second deadline; both canvas viewport cases and a sidebar test reload wait were the other failures.
- **Complete unchanged owner:** `mise run test:logged -- --name monaco-runtime-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/MonacoRuntime.spec.ts --workers=1 --output=output/playwright/monaco-owner` passed both viewport cases, exit 0 in 6.2 seconds.
- **Evidence:** host temporary directory `orkestrator-test-run.QC9tF3/browser-suite.log.gz`; original trace under `output/playwright/test-results/MonacoRuntime-*`. Sidebar fixes are commit `6d6f9b83f` and the final focused sidebar browser rerun passed all 30 cases.
- **Assessment:** confirmed intermittent recurrence. Host or fixture startup contention remains a hypothesis. No Monaco implementation, assertion, timeout or skip changed; the original aggregate remains failed.
