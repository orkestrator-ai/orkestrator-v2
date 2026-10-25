# Project navigation fixture misses its visibility deadline

- **ID:** 0234
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `project navigation matches the search row and contains Kanban notes`
- **File:** `e2e/WorkspaceBarHeight.spec.ts:54`, mobile Chromium
- **Checkout:** `1e5164ab` plus the held-send fixes; the owning spec and navigation implementation were unchanged.
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`
- **Worker configuration:** nine Playwright workers, desktop and mobile Chromium projects; repository tests were also running on the host.
- **Failure:** `getByTestId('project-navigation-bar')` was absent after the five-second `toBeVisible` deadline at line 61.
- **Suite counts:** 220 passed, 57 skipped, one failed out of 278 cases; reported duration 2.4 minutes.
- **Isolated rerun:** `mise run test:logged -- --name workspace-height-repro -- bunx playwright test --config e2e/playwright.config.ts e2e/WorkspaceBarHeight.spec.ts --project mobile-chromium --workers=1` passed all four cases unchanged, exit 0, wrapper duration 6.5 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.sYqNh3/browser.log.gz` retains the original failure.
- **Hypothesis:** the lazy-loaded navigation fixture did not finish starting within its visibility budget under concurrent browser and repository load. The isolated pass supports a startup timing issue; the underlying cause is not established. No assertion, timeout, or skip was changed.

The new held-send browser fixture was subsequently moved behind a lazy import,
matching the navigation fixture's existing pattern, to avoid loading the full
native controller on unrelated fixture routes. This reduces the new fixture's
startup cost for the rest of the suite; it does not establish the timeout's
root cause or change the failing test's assertions.

The final complete browser run passed, exit 0, in 70.5 seconds with
`CI=1 mise run test:logged -- --name browser-owned -- mise run test:browser`.
CI mode disables reuse of an existing fixture server, ensuring this run owns
its server. An intervening attempt had reused a server that disappeared during
the run (`ERR_CONNECTION_REFUSED` in
`/tmp/orkestrator-test-run.q7aeoz/browser-final.log.gz`); that infrastructure
failure is separate from the original navigation visibility timeout.


## Merge-validation recurrence — 2026-10-15

- **Original command:** `CI=1 mise run test:logged -- --name merge-browser -- mise run test:browser`, nine Playwright workers alongside the complete non-iOS suite.
- **Failure:** the same mobile Chromium case at `e2e/WorkspaceBarHeight.spec.ts:54` could not find `project-navigation-bar` within 5,000 ms at line 61.
- **Suite counts:** 228 passed, 61 skipped, one failed out of 290 cases in 3.0 minutes.
- **Isolated rerun:** `CI=1 mise run test:logged -- --name merge-browser-navigation-rerun -- mise run test:browser -- e2e/WorkspaceBarHeight.spec.ts --project mobile-chromium --workers=1` passed unchanged, exit 0, in 7.3 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.bNPq63/merge-browser.log.gz`.
- **Hypothesis:** the unchanged isolated pass is consistent with the existing fixture-startup timing hypothesis under aggregate load; the cause remains unproven. No test or product behavior was changed.

The complete follow-up `CI=1 mise run test:logged -- --name merge-browser-final -- mise run test:browser -- --workers=2` passed, exit 0, in 149.8 seconds.

## Transcript-paging validation — 2026-10-18

- **Command:** `mise run test:logged -- --name browser-suite -- mise run test:browser`.
- **Observed variant:** desktop `project navigation matches the search row and contains Kanban notes` and `project tabs retain keyboard focus rings in bar presentation` both encountered two matching navigation elements. The log also reported repeated `createRoot()` calls during HMR; source edits were still arriving during this run, so this does not establish a product regression or the original startup-timeout cause.
- **Counts:** 354 passed, 80 skipped, two failed (135.2 seconds logged). All transcript-paging browser cases passed.
- **Unchanged owner rerun:** `mise run test:logged -- --name workspace-browser-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/WorkspaceBarHeight.spec.ts --workers=1` passed both viewport projects in 9.6 seconds, exit 0. No navigation test, timeout, or assertion changed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dqfrtR/browser-suite.log.gz`.
- **Follow-up:** the complete browser suite passed with source edits paused (`browser-stable`, exit 0, 138.1 seconds). The new heavyweight paging fixture was then moved behind a lazy import, matching the existing native fixture.
