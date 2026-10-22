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

## Claude revision-token third main merge — 2026-10-22

- **Original command:** `mise run test:logged -- --name revtok-main3-browser -- mise run test:browser`, with the default component-browser workers alongside the repository aggregate and Electron checks.
- **Failure:** the same mobile native paging case failed its offset-preservation poll at line 70: 244.5 px rather than less than 3 px within 5000 ms. This differs from the earlier row-index assertion in this case history. The component suite reported 398 passed, 81 skipped and one failed across 480 cases (3.5 minutes).
- **Unchanged whole owner:** `mise run test:logged -- --name revtok-main3-transcript-paging-owner-correct -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1` passed all eight cases in 44.9 s. An earlier command used a nonexistent root config and exited before discovering any tests; it is not validation evidence.
- **Evidence:** `orkestrator-test-run.9O0EhD/revtok-main3-browser.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent occurrence in the same scenario, with a different assertion; rendering timing remains a hypothesis. No implementation, assertion, timeout or skip changed.
