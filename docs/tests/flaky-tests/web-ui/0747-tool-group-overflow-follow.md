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
