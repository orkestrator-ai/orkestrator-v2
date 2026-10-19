# Transcript paging observes the previous row index after prepend

- **ID:** 0483
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `native: paging before prose holds the original tool position` (mobile Chromium)
- **File:** `e2e/TranscriptPaging.spec.ts:57`
- **Original command:** `ORKESTRATOR_E2E_PORT=50649 mise run test:logged -- --name merge-component-browser-two-workers -- bunx playwright test --config e2e/playwright.config.ts --workers=2`.
- **Workers:** two Playwright workers alongside the non-iOS aggregate, isolated browser validation and other worktrees.
- **Failure:** the tool's row index was still `1`, expected greater than the original `1`, after the offset-preservation poll passed.
- **Suite counts:** 357 passed, 80 skipped and three failed across 440 cases (957.8 s logged). The other owners were DesignCanvas and DiffViewerMobile (0382).
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=50649 mise run test:logged -- --name merge-transcript-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1 --output output/playwright/merge-browser-owners/TranscriptPaging` passed all eight unchanged cases, exit 0, in 63.9 s.
- **Evidence:** `orkestrator-test-run.5S9NY7/merge-component-browser-two-workers.log.gz` below the host temporary directory; Playwright failure under `output/playwright/test-results/TranscriptPaging-native-pa-48048--the-original-tool-position-mobile-chromium/`.
- **Assessment:** confirmed intermittent observation. Prepend/render timing remains a hypothesis; no source, assertion, timeout or skip changed.
