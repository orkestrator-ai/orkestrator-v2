# Coordinator policy browser route receives a disposed API response

- **ID:** 9908
- **Status:** open
- **Date observed:** 2026-11-09
- **Test:** `[mobile-chromium] a coordinator turn delegates through Orkestrator tools, is refused a write and asks a question`
- **File:** `e2e/InteractionPolicyChecks.spec.ts:198`
- **Observing branch:** `attachment-routing-85d00c5e234d-r1`, head `5bcfc8b73`.
- **Base commit:** `1e491c07532e1d8ce08e143b79c9133dd317220e` (`git merge-base HEAD origin/main`).

## Failure and evidence

The nine-worker component browser suite reported `Error: route.fulfill: Fetch response has been disposed` at `e2e/InteractionPolicyChecks.spec.ts:84`. Its unchanged route handler forwards an `APIRequestContext.fetch` response to `route.fulfill`. The attachment-steering branch does not change this test, its route handler or interaction-policy implementation. No existing group-index row matched this owner; this is a new case rather than a counted recurrence.

Original command:

```sh
ORKESTRATOR_E2E_PORT=18452 ORKESTRATOR_PUBLIC_E2E_PORT=18453 ORKESTRATOR_REVIEW_BROWSER_WORKERS=4 mise run test:logged -- --name browser -- mise run test:browser
```

The reporter records nine workers; `ORKESTRATOR_REVIEW_BROWSER_WORKERS` is not the configuration's worker override. Failure evidence is `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vnIsPW/browser.log.gz`, with the trace under `output/playwright/test-results/InteractionPolicyChecks-a--5c07d-a-write-and-asks-a-question-mobile-chromium/trace.zip`.

The complete component run finished with 1,586 passed, 151 skipped and three failed (1,266.5 seconds, exit 1). The other two failures were the unchanged sidebar selection owner at both viewports. The chained public-site stage was not reached; a separate public-site suite passed (15.5 seconds, exit 0).

## Owning-file rerun

```sh
ORKESTRATOR_E2E_PORT=18452 mise run test:logged -- --name interaction-policy-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/InteractionPolicyChecks.spec.ts --workers=1 --output output/playwright/interaction-policy-owner
```

The complete unchanged owner passed with one worker at both viewports (126.7 seconds, exit 0). This separate single-owner command ran while the broad browser run continued on the host. No assertion, timeout or implementation changed. A response/context teardown race is a hypothesis; the available evidence does not establish the cause or an environmental exemption.
