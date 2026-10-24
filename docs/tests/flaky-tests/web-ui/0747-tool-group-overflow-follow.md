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
