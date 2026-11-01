# Assigned-composer shortcut startup misses the editable wait

- **ID:** 1902
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `Meta+I focuses the assigned agent composer and leaves the terminal chord usable` (mobile Chromium).
- **File:** `e2e/KeyboardShortcuts.spec.ts:308`.
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`.
- **Workers:** five Playwright workers; default aggregate and isolated-profile browser validation also ran on the shared host.
- **Failure:** the textbox under `[data-pane-leaf]` with a contenteditable was absent at the 5000 ms editable wait. The broad browser command later hit the logged runner's 1800 s group deadline, after reaching case 1122 of 1166; it did not produce final pass/fail totals or run the public-site suite.
- **Complete unchanged mobile owner:** `mise run test:logged -- --name repair-keyboard-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --project mobile-chromium --workers=1 --output output/agent-testing/mail-review-owners/keyboard` passed all 30 cases in 228.5 s, exit 0.
- **Evidence:** `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.LaDtCt/browser.log.gz`. Passing owner output was removed by the bounded logger.

This is an intermittent startup observation, not a root-cause diagnosis. No
keyboard implementation, assertion, timeout or skip changed in this review.
