# Data-saving gateway browser test times out in the aggregate

- **ID:** 1310
- **Status:** open
- **Date observed:** 2026-10-29
- **Test:** `[mobile-chromium] data saving survives reload, stays client-local and preserves event latency through resume and reconnect`
- **File:** `e2e/DataSavingGateway.spec.ts:18`
- **Revision:** `918d24a7d` on `mail-recipient-environment-name-acf90d0f8be8`; the gateway test and its implementation were unchanged.
- **Original command:** `ORKESTRATOR_E2E_PORT=14572 ORKESTRATOR_PUBLIC_E2E_PORT=14573 mise run test:logged -- --name browser -- mise run test:browser`, using nine Playwright workers.
- **Failure:** The 60,000 ms test deadline expired. Cleanup reported `browserContext.close: Target page, context or browser has been closed` at line 170; this does not establish which earlier operation consumed the deadline. The desktop case passed in the same aggregate.
- **Aggregate result:** 926 passed, 105 skipped, three failed in 15.7 minutes (946.3 s logged). The other two failures were the native branch-selection cases already tracked in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md). The combined command did not reach the public-site suite; a separate public-site run passed.
- **Failure evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.jirD7q/browser.log.gz`.
- **Isolated rerun:** `ORKESTRATOR_E2E_PORT=14572 mise run test:logged -- --name data-saving-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1 --output output/playwright/data-saving-owner` passed both viewport cases unchanged (exit 0, 45.0 s logged).
- **Assessment:** The aggregate failure followed by an unchanged isolated pass establishes intermittence. Timing under concurrent browser execution is a hypothesis; the root cause remains unconfirmed. No implementation, assertion, timeout, or skip changed.


## Second-backend review fixes — 2026-10-30

The exact `mise run test:logged -- --name browser -- mise run test:browser`
rerun repeated the mobile 60 s deadline and context-close cleanup error with
nine workers (972 passed, 106 skipped, 4 failed; 797.1 s). Evidence:
`orkestrator-test-run.Frb08t/browser.log.gz` under the host temporary directory.
The complete unchanged owner passed both viewports (exit 0, 32.7 s):

```sh
mise run test:logged -- --name data-saving-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1
```

This sequential rerun followed an invalid overlapping owner attempt; see
[1320](../aggregate-validation-runs/1320-second-backend-one-host-0244-validation.md).
No implementation, assertion, timeout or skip changed. The cause is unconfirmed.

## Merge-readiness review — 2026-10-30

Preparation's nine-worker `mise run test:logged -- --name browser -- mise run
test:browser` repeated the mobile 60-second deadline (971 passed, 106 skipped,
seven failed). A nine-worker six-owner diagnostic also repeated it (178 passed,
eight failed in 126.2 s), with evidence in
`orkestrator-test-run.XREdRM/browser-preparation-failures.log.gz`.

The complete unchanged owner passed both viewports alone with one worker
(51.9 s):

```sh
ORKESTRATOR_E2E_PORT=1457 mise run test:logged -- --name pr-review-DataSavingGateway-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1 --output output/playwright/pr-review-DataSavingGateway-owner
```

The default fixture port belonged to another checkout; it was left alone. No
gateway implementation, assertion, timeout or skip changed. This establishes
intermittence; host contention remains a hypothesis. Aggregate follow-up is
recorded in [1254](../aggregate-validation-runs/1254-merge-readiness-review-validation.md).
