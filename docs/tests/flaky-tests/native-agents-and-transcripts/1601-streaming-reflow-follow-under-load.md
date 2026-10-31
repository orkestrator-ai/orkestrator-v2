# Transcript bottom follow after a viewport reflow

- **ID:** 1601
- **Status:** open
- **Date observed:** 2026-10-31
- **Test:** `a follower stays at the latest row through a reflow`, both mobile-chromium and desktop-chromium.
- **File:** `e2e/StreamingTranscript.spec.ts:351`.
- **Original command:** `ORKESTRATOR_REVIEW_VALIDATION=1 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=4 mise run test:logged -- --name browser -- mise run test:browser`.
- **Worker configuration:** four Playwright workers, capped by the dedicated validation grant; one retry per failed test.
- **Failure:** the five-second poll at line 358 read a distance from the bottom of 88 pixels instead of less than 2 after resizing to 420 by 900. Both viewport cases passed on retry.
- **Suite counts:** 1,002 passed, 108 skipped, 13 failed, three flaky; 569.9 seconds. The third flaky result was the existing ToolGroupFold overflow-follow case (0747).
- **Owning-file rerun:** `ORKESTRATOR_REVIEW_VALIDATION=0 mise run test:logged -- --name streaming-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1 --output output/playwright/review-streaming-owner` passed all 26 cases without retries in 111.2 seconds. A separate isolated application browser run was active on its own profile and server during this rerun.
- **Evidence:** `/tmp/orkestrator-test-run.ZCNLHR/browser.log.gz` and `/tmp/orkestrator-test-run.acPUsW/summary.json`. The complete browser suite remains non-green.
- **Hypothesis:** viewport reflow and follow convergence are sensitive to timing; the cause is not established. No source assertion, timeout, or skip was changed to obtain the pass.
