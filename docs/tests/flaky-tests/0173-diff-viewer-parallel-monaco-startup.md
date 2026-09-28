# Diff viewer Monaco startup misses visibility checks in the parallel browser suite

- **ID:** 0173
- **Status:** open
- **Date observed:** 2026-09-28
- **Tests:** `the diff header fits a phone and the editor uses the full width`; `the new file state renders accessibly on a phone`
- **File:** `e2e/DiffViewerMobile.spec.ts`
- **Original command:** `mise run test:logged -- --name markdown-browser-suite -- mise run test:browser` (150 tests, six Playwright workers), while the repository suite and other worktrees were running.
- **Failure:** `.monaco-diff-editor` was missing or hidden at the five-second visibility deadline.
- **Isolated rerun:** `mise run test:logged -- --name browser-diff-viewer-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts --workers=1` passed.
- **Second parallel run:** Both cases passed in a repeat of the full browser suite.

## Current assessment

The fixture uses the real Monaco editor, whose startup may take longer under parallel load. The diff viewer code did not change in this task.
