# Non-sticky transcript anchor spec: history never scrolled away from the bottom under load (`e2e/StreamingTranscript.spec.ts`)

- **ID:** 0207
- **Status:** open
- **Date observed:** 2026-10-14
- **Test:** `[desktop-chromium] › e2e/StreamingTranscript.spec.ts:137 ›
  non-sticky history keeps its anchor while new transcript rows stream`.
- **Failure:** `expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(100)`
  at line 144 timed out after 5000 ms: after scrolling to the historic tool row
  and waiting eight frames, the viewport still read as near the bottom, so the
  anchor assertions never started.
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`
  while validating the OpenCode boundary cleanup branch
  (`opencode-bridge-a8c2ab5c85b9-r1`): 186 passed, 57 skipped, one failed. Two
  agent sessions were running full backend, web and root suites in sibling
  worktrees on the same host.
- **Isolated rerun:** `bunx playwright test --config e2e/playwright.config.ts
  e2e/StreamingTranscript.spec.ts --project desktop-chromium` passed three
  times in a row (6 passed, 3.3 s each).
- **Evidence:** `/tmp/orkestrator-test-run.Sd5TLg` (browser log),
  `output/playwright/test-results/StreamingTranscript-non-st-4370f--new-transcript-rows-stream-desktop-chromium/trace.zip`.
- **Hypothesis:** the programmatic scroll to the historic row had not settled
  within the frame budget under heavy host load. The branch removes unreachable
  renderer OpenCode code and moves OpenCode transcript normalization to the
  backend; it does not change the transcript scroller, Virtuoso follow logic or
  this spec's fixture.

## Recurrence — 2026-10-17

- **Commit:** `1456a8787` (Multi Review fullscreen keyboard scope and coverage).
- **Original command:** `mise run test:logged -- --name review-browser-suite -- mise run test:browser`.
- **Worker configuration:** 9 Playwright workers, with repository and isolated-stack suites also running.
- **Failure:** Mobile Chromium timed out after 5000 ms in `releaseStickyScroll`
  (line 46): distance from the bottom remained 1 instead of exceeding 100.
- **Suite counts:** 396 total, 326 passed, 69 skipped, 1 failed (3.1 minutes).
- **Isolated rerun:** `mise run test:logged -- --name review-transcript-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --project mobile-chromium --workers=1` passed all 6 tests (8.4 seconds including fixture startup).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.jqrGan/review-browser-suite.log.gz`.
- **Hypothesis:** Same scroll-settlement failure under load; no changes to the
  transcript scroller or its owning spec in this commit. The isolated pass
  establishes intermittence, not a root cause or a fix.


## Recurrence — 2026-10-23

- **Branch:** `animate-tool-calls-9f849713d495-r1`.
- **Original command:** `ORKESTRATOR_E2E_PORT=1457 mise run test:logged -- --name transcript-browser -- bunx playwright test --config e2e/playwright.config.ts StreamingTranscript.spec.ts ToolGroupFold.spec.ts --workers=2`.
- **Worker configuration:** Two Playwright workers, with the repository suite and static checks running on a host shared with other worktrees.
- **Failure:** Desktop Chromium timed out after 5000 ms in `releaseStickyScroll` (line 46); distance from the bottom remained 1 instead of exceeding 100. The history-anchor assertions did not run.
- **Suite counts:** 20 total, 17 passed, 3 failed; the other two failures were in the new folding fixture's scroll setup and were corrected separately.
- **Isolated rerun:** `ORKESTRATOR_E2E_PORT=1458 mise run test:logged -- --name streaming-isolated -- bunx playwright test --config e2e/playwright.config.ts StreamingTranscript.spec.ts --workers=1 --output output/playwright/streaming-results` passed all 14 cases (39.4 seconds including fixture startup).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.e3CStO/transcript-browser.log.gz`.
- **Observation:** The same existing scroll-release setup failed intermittently; the isolated owning-file pass does not establish a root cause or a fix.
