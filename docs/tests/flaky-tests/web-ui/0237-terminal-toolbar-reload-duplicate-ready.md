# Terminal toolbar reload briefly exposes duplicate readiness outputs

- **ID:** 0237
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `[mobile-chromium] › e2e/TerminalCornerToolbar.spec.ts:72 › touch
  history is visible and opens on tap at phone and tablet widths`.
- **Failure:** line 79's `terminal-ready` assertion after `page.reload()`
  resolved to two outputs, both `false`, causing a strict-mode violation.
- **Original command:** `mise run test:logged -- --name coordinator-all-browser --
  mise run test:browser`, nine Playwright workers alongside the non-iOS suite.
  Result: 220 passed, 61 skipped, 1 failed in 63.3 seconds.
- **Isolated rerun:** `mise run test:logged -- --name
  coordinator-browser-terminal-rerun -- mise run test:browser --
  e2e/TerminalCornerToolbar.spec.ts` passed in 7.3 seconds. The owning spec,
  terminal implementation, and terminal fixture were unchanged.
- **Full rerun:** `mise run test:logged -- --name coordinator-browser-final --
  mise run test:browser -- --workers=2` passed in 131.5 seconds (221 passed,
  61 skipped).
- **Evidence:** `/tmp/orkestrator-test-run.BfgDqZ/coordinator-all-browser.log.gz`.
- **Hypothesis:** readiness assertion races fixture replacement during a
  viewport change and reload under load. The isolated pass establishes
  intermittency, not the cause. No assertions were loosened or skipped.

## Auto-pipeline address validation — 2026-11-10

Observed on `autopipeline-text-boxes-7182fc46ef5e-r1` at `944b37af1`, based on
`8d0ae2764e0a5875144d15ee0f526608e6c1c1e8`. The reviewed commit `02f72782c` remains in history.

- **Original command:** `ORKESTRATOR_E2E_PORT=15182 ORKESTRATOR_PUBLIC_E2E_PORT=15183 mise run test:logged -- --name browser -- mise run test:browser`.
- **Aggregate result:** incomplete at the 1,800 s runner deadline; 69 named failures,
  last progress 1,194/1,814, with no final pass/skip totals. Public-site tests were not reached.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pcV7xY/browser.log.gz`.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=15214 mise run test:logged -- --name address-terminalcornertoolbar-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-terminalcornertoolbar-alone e2e/TerminalCornerToolbar.spec.ts`; exit 0, exit 0, one worker and both viewport projects.
- **Recurrence check:** `mise run flaky:recurrence -- 0237 --base 8d0ae2764e0a5875144d15ee0f526608e6c1c1e8 --registry-ref origin/main` reported `open`.

| Project | Location | Exact test |
| --- | --- | --- |
| mobile-chromium | `e2e/TerminalCornerToolbar.spec.ts:72` | touch history is visible and opens on tap at phone and tablet widths |

The owning spec and its implementation were unchanged. No assertion, deadline,
retry or skip was changed. This establishes intermittency, not its cause.
This observation was a reload timeout, not the duplicate-ready assertion in the original case.
The full run and remaining undetermined failures are recorded in
[9919](../aggregate-validation-runs/9919-auto-pipeline-fix-browser-owners.md).
