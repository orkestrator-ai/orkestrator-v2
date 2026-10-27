# Tool-group overflow follows an appended call in the aggregate

- **ID:** 0747
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `a waiting group that fits its cap follows appended calls as it starts overflowing`
- **Owning file:** `e2e/ToolGroupFold.spec.ts:245` (mobile Chromium).
- **Original command:** `ORKESTRATOR_E2E_PORT=61933 mise run test:logged -- --name merge-components-bounded -- bunx playwright test --config e2e/playwright.config.ts --workers=2`.
- **Failure:** the inner group's `scrollTop` was 704 instead of zero at the five-second poll (`:274`).
- **Suite counts:** 682 total, 575 passed, 102 skipped, five failed (1188.3 s logged).
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=61933 mise run test:logged -- --name merge-tool-group-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/merge-tool-group-owner` passed (68.3 s logged). Its `.last-run.json` reports `passed` and no failed tests.
- **Evidence:** host temporary artifact `orkestrator-test-run.Qvr7ev/merge-components-bounded.log.gz`; original browser artifacts under `output/playwright/test-results/`; passing owner output under `output/playwright/merge-tool-group-owner/`.
- **Context:** merge parents `3b5f889149d8c3603c869cd15b51d67af39c9aa6` and `0014505caeed69395b3cc996dd541fcc6df12c23`. Renderer and owning spec match `origin/main`.
- **Hypothesis:** browser timing or follow-state interaction under shared-host load; no cause has been established. The initial nine-worker run also suffered widespread navigation timeouts at host load average 160 and was interrupted before this bounded run. No assertion, timeout or skip changed.

## Multi Review inspector validation recurrence, 2026-10-24

- `mise run test:logged -- --name browser-suite -- mise run test:browser`
  ran 690 component cases with nine workers: 585 passed, 102 skipped and
  three failed (317.2 s). This case failed on desktop Chromium with the same
  `scrollTop` mismatch: 704 instead of zero at `:274`. The other two failures
  were the previously recorded native branch-suggestion cases in
  `e2e/AgentLaunchDialog.spec.ts`; all Multi Review cases passed.
- Both complete unchanged owners were rerun sequentially with
  `mise run test:logged -- --name browser-failure-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts e2e/AgentLaunchDialog.spec.ts --workers=1`.
  All sixteen ToolGroupFold cases passed. Both native branch-suggestion cases
  reproduced (`release/2.0` expected, `rel` received), leaving the combined
  rerun at eighteen passes and two failures (40.7 s). No assertions, skips or
  timeouts changed.
- Evidence: host temporary artifacts
  `orkestrator-test-run.3eBrrh/browser-suite.log.gz` and
  `orkestrator-test-run.r0ASNK/browser-failure-owners.log.gz`.
  The separate public-site browser suite passed (11.1 s).

## Transcript arrival validation — 2026-10-25

- `ORKESTRATOR_E2E_PORT=1462 mise run test:logged -- --name arrival-final-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptArrival.spec.ts e2e/ToolGroupFold.spec.ts --workers=2 --output output/playwright/arrival-final`
  ran 62 cases: 61 passed and this mobile case failed in 105.9 s. At
  `ToolGroupFold.spec.ts:471`, inner `scrollTop` was 704 instead of zero after
  the reader left the end of the virtualized body. All 24 arrival cases passed.
- The complete unchanged owning file passed all 38 cases in 116.1 s:
  `ORKESTRATOR_E2E_PORT=1462 mise run test:logged -- --name fold-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/fold-owner`.
- Evidence: host temporary artifacts `orkestrator-test-run.A2vguk/arrival-final-browser.log.gz`
  and `orkestrator-test-run.sbeXTO/summary.json`; browser failure artifacts are
  under `output/playwright/arrival-final/`. Repository and isolated application
  suites were also running. Timing or follow-state interaction under load
  remains a hypothesis. No owner assertion, timeout or skip changed.

## Resume cleanup coverage validation — 2026-10-25

The desktop waiting-group case received inner scrollTop 704 instead of zero in the five-worker component run and again in the complete unchanged one-worker owner rerun. No new owner pass was established; both results remain failed.

The original component run reported 734 passed, 102 skipped and six failed. The six complete owning files ran sequentially with one worker: 80 passed, one skipped and three failed (307.4 s). Exact commands, per-owner results and artifact paths are in [0822](../aggregate-validation-runs/0822-resume-cleanup-coverage-validation.md). No owning implementation, assertion, deadline or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** three recurrences (two-worker, nine-worker, and two-worker on 2026-10-25), each with `scrollTop` 704 instead of zero and a passing one-worker owner rerun. The resume-cleanup recurrence above also failed in the unchanged one-worker owner, so this case does not always pass in isolation. The test is now at `ToolGroupFold.spec.ts:442` after #1227. [0825](../aggregate-validation-runs/0825-dependency-upgrades-0032-validation.md) also reported a painted-gap failure at `ToolGroupFold.spec.ts:79` in the same file.
- **Next step:** record the group's follow state and inner `scrollTop` on each frame during the append, so the next failure shows whether follow was lost or never set.


## Hidden-resume review recurrence — 2026-10-26

- **Failure:** Desktop `a waiting group that fits its cap follows appended calls as it starts overflowing` retained inner scrollTop 704 instead of zero at five seconds.
- **Complete unchanged owner:** `mise run test:logged -- --name tool-group-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/resume-tool-group-owner` passed (100.3 s logged).
- **Aggregate command, workers, counts and evidence:** [hidden-resume review validation](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#hidden-resume-review-validation--2026-10-26). The backend used two Bun workers; the component suite used nine Playwright workers. Concurrent worktree validation was active.
- **Assessment:** confirmed intermittent recurrence; no owning source, assertion, deadline or skip changed. The original aggregate remains failed; no root cause was established.

## Title-tooltip (todo 0202) validation recurrence — 2026-10-27

- **Failure:** Mobile `a waiting group that fits its cap follows appended calls as it starts overflowing` retained inner scrollTop 704 instead of zero (`ToolGroupFold.spec.ts:471`) in `mise run test:browser` with nine Playwright workers (774 passed, 103 skipped, three failed).
- **Complete unchanged owner:** `mise run test:logged -- --name toolgroupfold -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts` passed (23.9 s logged).
- **Aggregate evidence:** [1155](../aggregate-validation-runs/1155-webkit-title-tooltip-0202-validation.md). The branch changes only `MobileAppShellLayout` and its tests, which this spec does not render.
- **Assessment:** intermittent recurrence; no owning source, assertion, deadline or skip changed.
