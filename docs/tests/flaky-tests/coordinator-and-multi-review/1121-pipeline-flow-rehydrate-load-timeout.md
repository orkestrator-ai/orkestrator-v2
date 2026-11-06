# Pipeline flow rehydration browser case times out in parallel aggregate

- **ID:** 1121
- **Status:** open
- **Date observed:** 2026-10-27
- **Test:** `a review pass rehydrates progress missed while inactive and after reload`
- **Owning file:** `e2e/PipelineFlow.spec.ts:292`
- **Original command:** `mise run test:logged -- --name flow-graph-browser -- mise run test:browser`
- **Failure:** Desktop Chromium exceeded the 30-second test timeout during `page.goto` in the parallel browser aggregate.
- **Suite counts:** 769 passed, 103 skipped, 42 failed across 914 tests.
- **Isolated rerun:** The complete owning file passed with one worker in 94.4 seconds, including this case.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xMuhLD/flow-graph-browser.log.gz`; isolated owner run `pipeline-flow-browser-owner`.
- **Assessment:** The timeout occurred amid broad parallel browser timeouts on a heavily loaded host. No timeout or assertion was changed to obtain the isolated pass.


## Merge-readiness review — 2026-10-30

Preparation's exact `mise run test:logged -- --name browser -- mise run
test:browser` repeated the desktop 30-second timeout, this time in
`page.reload` at `e2e/PipelineFlow.spec.ts:490`. The nine-worker suite reported
971 passed, 106 skipped and seven failures. The complete unchanged owner
passed alone with one worker in 131.3 s:

```sh
ORKESTRATOR_E2E_PORT=1457 mise run test:logged -- --name pr-review-PipelineFlow-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/PipelineFlow.spec.ts --workers=1 --output output/playwright/pr-review-PipelineFlow-owner
```

The exact aggregate rerun and other owner results are recorded in
[1254](../aggregate-validation-runs/1254-merge-readiness-review-validation.md).
No pipeline implementation, assertion, timeout or skip changed.

## Coordinator unavailable-platform review — 2026-11-06

The mobile review-pass rehydration case at line 551 exceeded 30 s during
`ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name browser -- mise run test:browser`.
It timed out at page.reload (line 568). Five workers were active; the broad
run stopped at its 1800000 ms deadline after 708/1596 case starts and nine
named failures. Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.8yBzhf/browser.log.gz`.

The complete unchanged owner was rerun with:

```sh
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-pipeline-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/PipelineFlow.spec.ts --workers=1 --output output/agent-testing/review-address-owners/pipeline
```

It exited 1 in 337.3 s: 84 passed, one skipped and one failed. The original
rehydration case was not among its failures; the new failure was desktop
`completion in fullscreen lands in the overlay and then the panel`, with
the Notes node outside the viewport after exiting fullscreen (line 1134).
Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.yAfPM6/review-pipeline-browser-owner.log.gz`.
This is not a complete isolated-owner pass or an environmental excuse. No
assertions, timeouts, skips or implementation were changed.
