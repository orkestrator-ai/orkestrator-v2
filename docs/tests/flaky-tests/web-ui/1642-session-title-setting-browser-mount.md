# Session-title setting missing during browser mount

- **ID:** 1642
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `Session titles discloses where a first message goes and persists its choice`
- **Owner:** `e2e/GlobalSettings.spec.ts`, mobile-chromium project.
- **Command:** `mise run test:logged -- --name review-settings-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/GlobalSettings.spec.ts --workers=1`.
- **Failure:** the first `getByRole("combobox", { name: "Session titles" })` assertion found no element within 5000 ms. The complete owner reported seven passed and one failed in 80.0 s. Both Claude background-limit save/remount/reset regressions passed.
- **Unchanged complete-owner rerun:** the exact command above passed all eight cases in 80.8 s. No source, assertion, timeout, retry or worker-count changes were made to this owner between these runs.
- **Evidence:** failing output is `/tmp/orkestrator-test-run.XgPx6H/review-settings-browser.log.gz`; passing output was removed by `test:logged`.
- **Context:** full repository tests and isolated browser validation also ran on this host. Load averages observed around this work ranged from 23 to 43. Delayed renderer mounting is a hypothesis, not a confirmed cause; no failure screenshot or DOM snapshot establishes it.
