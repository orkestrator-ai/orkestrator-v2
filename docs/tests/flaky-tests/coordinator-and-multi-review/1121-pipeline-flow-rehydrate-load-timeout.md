# Pipeline flow rehydration browser case times out in parallel aggregate

- **ID:** 1121
- **Status:** resolved
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

## Triage note (2026-11-15)

Class A candidate. A navigation (`page.goto`/`page.reload`) or step used up Playwright's 30 s test deadline, or an assertion hit the 5 s `expect` default, while the host was loaded. The spec has no fixed sleep or ad-hoc wall-clock check of its own on the failing path. Nothing was changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`timeout` and `expect.timeout`), but every group's component specs share that config, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced, because the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** Playwright's default deadlines ran out on a loaded host while the test was waiting on a real signal. Every recorded failure is the 30 s default test timeout (`Test timeout of 30000ms exceeded`, in `page.goto`, `page.reload`, a click or a web-first assertion still in progress) or the 5 s default `expect` budget; none is a value mismatch, crash or lost interaction, and the failing calls pass no smaller timeout of their own. The specs measure no latency, so those defaults were acting as speed checks rather than hang watchdogs.
- **Fix:** the component browser config, `e2e/playwright.config.ts` (`mise run test:browser`), now sets `timeout: 120_000` (was Playwright's 30 s default) and `expect: { timeout: 30_000 }` (was 5 s). Navigations carry no timeout of their own, so they are bounded by the 120 s test timeout. No assertion changed.
- **Reproduced:** no — the recorded failure was not reproduced before the change. The evidence is weaker: a rerun of the component browser specs that had failed in a loaded run, with the new config, gave 112 passed; the one remaining failure there (`ToolGroupFold.spec.ts:127`, [1012](../web-ui/1012-live-tool-fold-threshold-gap.md)) also fails with main's config and is unrelated.
- **Stress:** none beyond that rerun.

The 2026-11-06 owner rerun's separate failure, desktop `completion in fullscreen lands in the overlay and then the panel` (Notes node outside the viewport at line 1134), is a different test and a position mismatch, not a deadline; this resolution does not cover it, and a recurrence of it needs its own case.

A recurrence that hangs until near the new budget (a navigation or assertion timing out at 120 s or 30 s) is a real hang, not this deadline: reopen this case and record it.
