# Sidebar fixture module requests aborted by network changes

- **ID:** 4291
- **Status:** environmental
- **Date observed:** 2026-11-04
- **Tests:** `real panels restore width, bound reversal pins and release once`
- **File:** `e2e/SidebarMotion.spec.ts`

Command: `ORKESTRATOR_E2E_PORT=18441 NODE_ENV=development mise run test:logged -- --name sidebar-motion-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/SidebarMotion.spec.ts --workers=1`.
One worker: 5 pass / 1 fail in 39.6 seconds. Mobile main content never mounted.
The saved Playwright trace shows `net::ERR_NETWORK_CHANGED` for module requests,
including resizable.tsx, CompactRepositoryList.tsx, and useSidebarPanelMotion.ts.
Evidence: `/tmp/orkestrator-test-run.3E4kDb/sidebar-motion-browser.log.gz`.

The complete owner rerun with the identical command passed all six tests in
23.7 seconds. No assertions were relaxed between these runs. Earlier attempts
also encountered missing content; a separate first invocation was refused by
the fixture ownership guard because port 1422 belonged to another checkout.
That server was left alone; this run used a dedicated port.

## Mitigation

The spec's `openFixture` reloads the fixture, at most twice, only when a request
failed with `net::ERR_NETWORK_CHANGED` before the main content appeared, and
records a `retry` annotation naming this case. Any other startup failure still
fails the test. This matches the dev-retry handling in 0167.
