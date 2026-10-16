# Diff viewer Monaco startup misses visibility checks in the parallel browser suite

- **ID:** 0173
- **Status:** open
- **Date observed:** 2026-09-28
- **Tests:** `the diff header fits a phone and the editor uses the full width`; `the new file state renders accessibly on a phone`; `the deleted file state renders accessibly on a phone` (observed across the two runs)
- **File:** `e2e/DiffViewerMobile.spec.ts`
- **Original command:** `mise run test:logged -- --name markdown-browser-suite -- mise run test:browser` (150 tests, six Playwright workers), while the repository suite and other worktrees were running.
- **Failure:** `.monaco-diff-editor` was missing or hidden at the five-second visibility deadline.
- **Isolated rerun:** `mise run test:logged -- --name browser-diff-viewer-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts --workers=1` passed.
- **Second parallel run:** Both cases passed in a repeat of the full browser suite.
- **Additional run:** A separate six-worker browser run alongside the repository suite timed out on all three mobile cases; 97 passed, 48 skipped, and 5 failed across 150 cases. The owning file passed with two workers. In a later browser suite run without the repository suite, every Diff Viewer case passed.

## Current assessment

The fixture uses the real Monaco editor, whose startup may take longer under parallel load. The diff viewer code did not change in this task.

## 2026-10-16 recurrence

`mise run test:browser` on `overnight-opencode-skew-guard-854f012a1bb0` (browser
fixture-server ownership guard; no diff viewer code changed) failed the two
mobile cases `the diff header fits a phone and the editor uses the full width`
and `the new file state renders accessibly on a phone`, with 254 passed, 61
skipped and 3 failed across 318 cases (2.8 m); the third failure was case 0249.
The failure text was not kept. `bunx playwright test --config
e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts e2e/MultiReviewFlow.spec.ts
--workers=1` passed (21 passed, 5 skipped), and a repeat of the full browser
suite passed (257 passed, 61 skipped).
