# Annotation source-hints capture loses Add note focus

- **ID:** 2395
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `development source hints survive native spool and renderer capability gating into verified stored evidence`
- **File:** `e2e/agent-testing/web-annotations-electron.spec.ts:1587`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=agent-session-import-review-fixes ORKESTRATOR_AGENT_TEST_RUN_ID=session-import-review-fixes mise run test:logged -- --name electron-preview-session-import -- mise run test:agent:electron`, one worker on macOS, branch based on `15f22fc6d`.
- **Failure:** `expect(locator).toBeFocused()` on `getByRole('button', { name: 'Add note', exact: true })` received inactive after 5 seconds. The owning file and its legacy-preview flow were unchanged by the session-import fixes.
- **Suite counts:** 52 total, 40 passed, 2 failed, 2 skipped, 8 did not run; 377.5 seconds. All 21 service-preview tests passed.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=agent-session-import-review-fixes ORKESTRATOR_AGENT_TEST_RUN_ID=session-import-review-isolated-annotations mise run test:logged -- --name annotation-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts` passed the complete unchanged owner: 14 passed, 1 skipped, 78.1 seconds, one worker.
- **Evidence:** full-suite compressed log `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.4ofvtx/electron-preview-session-import.log.gz`; isolated results under `output/agent-testing/session-import-review-isolated-annotations/electron/`.
- **Hypothesis:** native focus changed during the full Electron run. The isolated pass establishes intermittent behavior, but does not establish who moved focus. No assertion, timeout or skip was changed.
