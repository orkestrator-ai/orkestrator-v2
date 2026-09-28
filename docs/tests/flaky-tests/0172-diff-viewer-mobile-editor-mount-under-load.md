# Diff Viewer mobile editor mount times out under concurrent validation

- **ID:** 0172
- **Status:** environmental
- **Date observed:** 2026-09-28
- **Tests:** `the diff header fits a phone and the editor uses the full width`, `the new file state renders accessibly on a phone`, and `the deleted file state renders accessibly on a phone` (mobile Chromium)
- **File:** `e2e/DiffViewerMobile.spec.ts:38`, `:111`
- **Original command:** `mise run test:logged -- --name browser-suite -- mise run test:browser`; Playwright used six workers while `mise run test` was also running on the host.
- **Failure:** `.monaco-diff-editor` did not appear within the five-second visibility wait in three mobile cases. The browser suite reported 97 passed, 48 skipped, and 5 failed across 150 cases; three failures were these cases.
- **Isolated rerun:** `mise run test:logged -- --name browser-diff-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts --workers=2` passed.
- **Second suite run:** `mise run test:logged -- --name browser-suite-final -- mise run test:browser` ran without the full repository suite; every Diff Viewer case passed. The suite still had two unrelated Design Canvas failures.

## Current assessment

Monaco initialization missed the short visibility wait under concurrent suite load. The owning file passed alone, and no Diff Viewer code changed in this review fix. A repeat under controlled host load would distinguish resource contention from an editor initialization race.
