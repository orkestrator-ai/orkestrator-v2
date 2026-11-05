# Change tracking image fallback after reload

- **ID:** 6660
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `an unreachable image stream retries base64 and releases its capability`
- **File:** `e2e/ChangeTracking.spec.ts:137`
- **Browser:** mobile Chromium

During coordinator C3 review fixes, the component suite failed at line 189:
after reload, the image with accessible name `image.png` was absent instead of
having its base64 source. The test exceeded 30 seconds.

Original command:
`ORKESTRATOR_E2E_PORT=15427 ORKESTRATOR_PUBLIC_E2E_PORT=15428 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=2 mise run test:logged -- --name browser -- mise run test:browser`.
The run was stopped after three reported failures and 82 started cases; there
is no complete pass count. Two other failures were the mobile AgentUsage cases
tracked in 0749. Evidence: `/tmp/orkestrator-test-run.PDmU8s/browser.log.gz`.

Owner rerun:
`ORKESTRATOR_E2E_PORT=15429 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=2 mise run test:logged -- --name browser-findings-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentUsage.spec.ts e2e/ChangeTracking.spec.ts`.
All eight unchanged ChangeTracking cases passed across both viewports; all four
AgentUsage cases failed. Total: 8 passed, 4 failed in 182.5 seconds.
Evidence: `/tmp/orkestrator-test-run.J1rBxn/browser-findings-isolated.log.gz`.

The default suite was running concurrently on this shared host. No cause has
been established. No image implementation, assertion, timeout or skip changed.
