# Design Canvas browser flow times out under concurrent validation

- **ID:** 0171
- **Status:** open
- **Date observed:** 2026-09-28
- **Test:** `canvas edits, script isolation, missed events, conflict and reload` (mobile and desktop Chromium)
- **File:** `e2e/DesignCanvas.spec.ts:16`
- **Original command:** `mise run test:logged -- --name browser-suite -- mise run test:browser`; Playwright used six workers while `mise run test` was also running on the host.
- **Failure:** The mobile case exhausted its 30-second budget while clicking `Switch tab`; the desktop case lost its iframe session while waiting for `Changed while away`. The browser suite reported 97 passed, 48 skipped, and 5 failed across 150 cases; two failures were this test.
- **Isolated rerun:** `mise run test:logged -- --name browser-design-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=2` passed.
- **Second suite run:** `mise run test:logged -- --name browser-suite-final -- mise run test:browser` ran without the full repository suite and still timed out in the same mobile and desktop case. Both pages were closed at the 30-second test deadline while clicking `Switch tab` near line 254. This run reported 100 passed, 48 skipped, and 2 failed.

## Current assessment

The case passes when its file runs alone with two workers but exceeds the 30-second budget in the six-worker browser suite, including without other suites. Suite-level contention or shared fixture behavior remains unproven. No Design Canvas code changed in this review fix.
