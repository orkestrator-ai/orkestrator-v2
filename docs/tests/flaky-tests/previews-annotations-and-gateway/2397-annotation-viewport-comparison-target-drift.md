# Annotation viewport comparison adds a target difference

- **ID:** 2397
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `result captures label stability and comparison differences, and Show on page reports an expired sign-in redirect`
- **File:** `e2e/agent-testing/web-annotations-electron.spec.ts:2326`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=agent-session-import-review-fixes ORKESTRATOR_AGENT_TEST_RUN_ID=session-import-review-fixes mise run test:logged -- --name electron-preview-session-import -- mise run test:agent:electron`, one worker on macOS, branch based on `15f22fc6d`.
- **Failure:** the `different viewport` comparison expected `["viewport"]` and received `["target", "viewport"]`. The comparison code and its legacy-preview flow were unchanged by the session-import fixes.
- **Suite counts:** 52 total, 31 passed, 3 failed, 3 skipped, 15 did not run; 259.3 seconds. The other failures were the new import fixture's route ordering (subsequently corrected) and workspace-realm startup.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=agent-session-import-review-fixes ORKESTRATOR_AGENT_TEST_RUN_ID=session-import-review-isolated-annotations mise run test:logged -- --name annotation-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts` passed the complete unchanged owner: 14 passed, 1 skipped, 78.1 seconds, one worker.
- **Evidence:** original compressed log `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.tAculv/electron-preview-session-import.log.gz`; isolated results under `output/agent-testing/session-import-review-isolated-annotations/electron/`.
- **Hypothesis:** target identity or geometry changed across the viewport comparison. The isolated pass establishes intermittent behavior; its cause is not established. No assertion, timeout or skip was changed.
