# Streaming transcript selection loses row zero before selection setup

- **ID:** 0631
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `[desktop-chromium] › a selection in the first row survives clipped overscan up to the protection bound`
- **File:** `e2e/StreamingTranscript.spec.ts:195`
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`
- **Worker configuration:** default Playwright configuration, alongside the complete repository suite and isolated browser suite.
- **Failure:** the 30-second test deadline expired waiting for `[data-chat-message-index="0"]` in `row.elementHandle()` at line 208, after the visibility assertion and eight animation frames.
- **Suite counts:** 454 total, 371 passed, 80 skipped, 3 failed (281.7 s). The other failures were the two AgentLaunchDialog native branch-suggestion cases; these also failed their owning-file rerun.
- **Isolated rerun:** `mise run test:logged -- --name streaming-transcript-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1 --output=output/playwright/schedule-wakeup-streaming-repro` passed all 14 cases across both viewport projects (22.0 s).
- **Evidence:** `orkestrator-test-run.kaCCGS/browser.log.gz` under the host temporary directory. An earlier overlapping owning-file rerun encountered Playwright artifact-directory ENOENT errors; it is not the passing isolation evidence.
- **Hypothesis:** the row leaves the virtualized render window between the initial visibility check and handle capture under load. The changed ScheduleWakeup rendering path is absent from this fixture. No assertion, timeout, or skip in this owner changed.
