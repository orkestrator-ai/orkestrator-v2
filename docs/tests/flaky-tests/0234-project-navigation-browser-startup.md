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
