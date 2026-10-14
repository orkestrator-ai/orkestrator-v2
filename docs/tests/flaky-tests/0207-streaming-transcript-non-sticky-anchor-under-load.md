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
