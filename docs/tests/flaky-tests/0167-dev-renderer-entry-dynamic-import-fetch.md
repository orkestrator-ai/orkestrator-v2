# Dev renderer entry fails to load with "Failed to fetch dynamically imported module"

- **ID:** 0167
- **Status:** environmental
- **Date observed:** 2026-09-26
- **Tests:** cases in `e2e/agent-testing/native-draft-attachments.spec.ts` that load
  the app right after a previous case deleted its environments
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=inconsistency-remediation-qa bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts native-draft-attachments`
  against a `dev:test --fixture` profile on branch
  `implement-improvements-ecf7c41c13cd-r1`
- **Failure:** the page showed "Orkestrator couldn’t connect". The renderer's
  console showed `[DesktopStartup] renderer-load-failed` with `Failed to fetch
  dynamically imported module: http://127.0.0.1:<gateway>/src/renderer-entry.tsx`.
  The backend kept running and logged no error. Two of three full runs of the
  spec hit it once each, on different cases.
- **Isolated check:** twelve consecutive loads of the same profile, with no
  environment churn, all started normally.

## Current assessment

This is the Vite dev server (through the gateway proxy) failing one source-module
fetch under load. A production build serves a bundle and has no such fetch.
The draft spec retries the load once, only for this exact startup message, and
records the retry as a `retry` annotation. Any other startup failure still fails
the case. Keep this open as environmental until the dev gateway's module
fetches are shown to fail for another reason.
