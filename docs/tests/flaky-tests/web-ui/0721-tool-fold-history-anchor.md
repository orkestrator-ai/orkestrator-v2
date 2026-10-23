# Tool folding briefly moves a released reader's history anchor

- **ID:** 0721
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `folding below a released reader preserves their history position`
- **Owning file:** `e2e/ToolGroupFold.spec.ts:127`
- **Original command:** `ORKESTRATOR_E2E_PORT=15423 mise run test:logged -- --name component-browser -- bunx playwright test --config e2e/playwright.config.ts --workers=2`
- **Failure:** desktop Chromium observed a maximum anchor displacement of 66.75 px; the assertion permits 2 px. The suite ran alongside the non-iOS repository tests.
- **Suite result:** 505 passed, 95 skipped, four failed across 604 cases (443.2 s logged). The other failures were native branch suggestion selection in both viewports and desktop Cursor steering feedback.
- **Complete unchanged owning-file rerun:** `ORKESTRATOR_E2E_PORT=15423 mise run test:logged -- --name tool-fold-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/tool-fold-owner` passed (exit 0, 9.9 s logged).
- **Evidence:** `orkestrator-test-run.qODnC3/component-browser.log.gz` below the host temporary directory; the original failure trace is under `output/playwright/test-results/ToolGroupFold-folding-belo-cffce-rves-their-history-position-desktop-chromium/`.
- **Assessment:** the passing complete owner establishes an intermittent failure. Concurrent renderer or host scheduling is a hypothesis, not a confirmed cause. No folding implementation, assertion, timeout or skip changed.
