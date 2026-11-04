# HTML preview fixture startup

- **ID:** 4043
- **Status:** open
- **Date observed:** 2026-11-04
- **Test:** `HTML boundary refuses resources, scripts, forms and mutated navigation`; `preview releases keyboard focus, saves, and permits divider dragging`
- **File:** `e2e/HtmlPreview.spec.ts`

Renumbered from 4042, which `backend-services-and-tooling/4042-toolchain-full-check-stamp-same-instant.md` had already taken.

Mobile Chromium:

- `HTML boundary refuses resources, scripts, forms and mutated navigation` initially reached its page evaluation before React mounted the iframe (`Cannot set properties of null (setting 'srcdoc')`). An explicit attached assertion now synchronizes that test's setup.
- `preview releases keyboard focus, saves, and permits divider dragging` timed out after 30 seconds waiting for the Report heading in the iframe, with no page snapshot. This test was unchanged on the passing rerun; the underlying startup cause is unconfirmed.

Original command: `NODE_ENV=development mise run test:logged -- --name html-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/HtmlPreview.spec.ts --workers=2`. Two workers, 2 passed / 2 failed in 31.3 seconds. Evidence: `/tmp/orkestrator-test-run.SULix9/html-browser.log.gz`.

Owning-file rerun: same command, 4 passed / 0 failed in 6.0 seconds, after adding the boundary test's mount assertion. The keyboard/divider test was unchanged. Earlier successful runs took 6.3 and 6.7 seconds. No test was skipped or assertion relaxed. Fixture startup/Vite cold loading is a hypothesis only; no browser exception was established.
