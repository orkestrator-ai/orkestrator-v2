# Held-history churn begins before the frame probe

- **ID:** 1605
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `native: a held row that keeps changing past the revision budget does not flicker`.
- **File:** `e2e/TranscriptPaging.spec.ts:447`.
- **Original command:** `mise run test:logged -- --name transcript-paging -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=2`.
- **Failure:** desktop expected one additional history read and received zero; the complete file reported 32 passed and six failed in 249.6 s. The other failures were in unchanged paging cases.
- **Initial isolated rerun:** `mise run test:logged -- --name churn-only -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --grep 'revision budget' --workers=1` passed both viewport projects in 33.7 s before the complete-file recurrence.
- **Evidence:** `/tmp/orkestrator-test-run.jGRplI/transcript-paging.log.gz`.

The fixture originally moved its reconciliation token from the first read.
The first reread could therefore finish before the test installed its probe
and captured the request count. A nine-second probe then allowed no further
read, because reconciliation deliberately waits thirty seconds between walks.
The strict positive-read assertion exposed this uncontrolled startup ordering.

The fixture now exposes `startPagingFixtureChurn`. The test waits for the
opening page and loading control to settle, installs its frame probe, then
starts churn explicitly. Playwright's clock advances nine seconds; the test
requires exactly one reread, 121 held rows on every sampled frame, and no
loading frames. No assertion or timeout was relaxed.

The repaired case passed all six stress runs (three at each viewport):

```sh
mise run test:logged -- --name churn-controlled -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --grep 'revision budget' --repeat-each=3 --workers=2 --output=output/playwright/held-history-churn
```

The command exited zero in 58.9 s. The repaired mobile case also completed
without a reported failure in the exact broad browser rerun. That broad
command reached 590 of 1,142 scheduled cases and reported 29 failures before
the logged runner's 1,800-second deadline; its chained public-site suite did
not start. Evidence: `/tmp/orkestrator-test-run.xTajEb/browser.log.gz` and
`output/playwright/test-results/`. The focused stress run used a separate
output directory to preserve those broad-run artifacts.
