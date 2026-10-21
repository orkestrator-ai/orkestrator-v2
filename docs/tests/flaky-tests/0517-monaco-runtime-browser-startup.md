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
