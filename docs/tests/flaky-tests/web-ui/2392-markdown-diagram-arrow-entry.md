# Diagram source arrow entry intermittently remains collapsed

- **ID:** 2392
- **Status:** open
- **Test:** `arrow keys enter and leave a collapsed diagram fence without losing source`
- **File:** `e2e/MarkdownEditorDiagram.spec.ts:39`

On 2026-11-01, notification-bar preparation's `mise run test:logged -- --name browser -- mise run test:browser` reported this mobile Chromium case flaky after a retry. The first attempt expected `data-markdown-diagram-source="open"` and received `collapsed` at the 5000 ms assertion deadline. Captured output does not expose the granted worker count. Browser totals: 1041 passed, 108 skipped, four unrelated Cursor failures and this one flaky case. Evidence: `.orkestrator/review-artifacts/review-validation-eb40d1d2-656b-44f0-9a8f-1c2970a9e415/validation-06.stderr.txt`.

The unchanged case passed on both desktop and mobile with one worker, alongside the notification-bar reload regression (four cases total; logged command passed in 25.1 s):

```sh
ORKESTRATOR_E2E_PORT=15488 mise run test:logged -- --name fix-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/MultiReviewFlow.spec.ts e2e/MarkdownEditorDiagram.spec.ts --grep 'omits redundant fix success|arrow keys enter' --workers=1
```

The cause remains unknown. No diagram code, assertion, timeout or skip changed.
