# Multi Review flow browser reload cases time out in parallel aggregate

- **ID:** 1120
- **Status:** open
- **Date observed:** 2026-10-27
- **Test:** MultiReviewFlow browser reload and divider cases
- **Owning file:** `e2e/MultiReviewFlow.spec.ts`
- **Original command:** `mise run test:logged -- --name flow-graph-browser -- mise run test:browser`
- **Failure:** Four retained clean-review PR snapshot cases timed out in `page.reload`; three divider capture cases timed out while reloading in desktop Chromium.
- **Suite counts:** 769 passed, 103 skipped, 42 failed across 914 tests.
- **Isolated rerun:** The complete owning file passed with one worker in 287.5 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xMuhLD/flow-graph-browser.log.gz`; isolated owner run `multi-review-flow-browser-owner`.
- **Assessment:** These failures occurred among broad parallel browser timeouts on a heavily loaded host. No timeout or assertion was changed to obtain the isolated pass.


## Backend logger review repair — 2026-11-02

The four-worker `review-fix-browser` command documented in
[1902](../web-ui/1902-assigned-composer-shortcut-startup.md#backend-logger-review-repair--2026-11-02)
reported four mobile 30-second deadlines in this owner:

- `a retained clean-review PR notice reflects the current ready snapshot after reload`
- `a retained clean-review PR notice reflects the current interactive snapshot after reload`
- `divider follows a captured mouse at 150% application CSS zoom`
- `divider follows a captured mouse at 75% application CSS zoom`

The interactive case timed out while clicking the PR tab, and the 75% case
while reloading; the other two reported the test deadline. The run was stopped
after these failures and the keyboard owner rerun: 311 passed, five failed,
four interrupted, 62 skipped, 822 not run, 1,038.5 s, exit 130. Evidence: host
temporary artifact directory `orkestrator-test-run.bSlWGN`,
`review-fix-browser.log.gz`.

This owner was not rerun alone in this repair turn. These are outstanding
browser validation failures; the older isolated pass does not establish that
this observation is flaky. No MultiReviewFlow implementation, assertion,
timeout or skip changed.

## Recurrence 2026-11-13

- **Branch:** `reviewer-failure-c64fd66ac37e-r1` at `4ed678dcc`, base
  `17d28238c`. `mise run flaky:recurrence -- 1120 --base 17d28238c` returned
  "open. Record the failure as a recurrence". The branch adds a
  "could not review" label and a `couldNotReview` fixture scenario to the
  Multi Review graph; it does not change the PR notice, the divider or
  reload handling.
- **Command:** `bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/MultiReviewFlow.spec.ts e2e/PipelineFlow.spec.ts --workers=2`
  at load average about 90 to 105 on 16 cores (the full `mise run test:browser`
  had already timed out at its 1,800 s deadline with 286 of 522 tests failing,
  mostly `page.goto` timeouts). 187 passed, 10 failed, 5 skipped (27.2 min).
- **Failures here:** `a retained clean-review PR notice reflects the current … snapshot after reload`
  (ready, interactive, consolidating and reviewing on mobile; consolidating on
  desktop) and `divider follows a captured mouse at …` (100% mobile; 75% and
  150% desktop), all at the 30 s test timeout (`page.reload`, a PR-tab
  attribute or an inspector text poll).
- **Isolated rerun:** the same tests with one worker
  (`--grep "retained clean-review PR notice|divider follows a captured mouse|…"`)
  all passed (17 of 18; the one failure was the PipelineFlow case recorded in
  [6460](../aggregate-validation-runs/6460-component-browser-specs-under-host-load.md)).
