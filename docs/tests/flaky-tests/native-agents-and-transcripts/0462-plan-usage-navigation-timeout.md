# Browser plan-usage navigation timeout

- **ID:** 0462
- **Status:** open
- **Date observed:** 2026-10-18
- **File:** `e2e/PlanUsage.spec.ts`
- **Test:** `stale platform and account quotas retain their timestamp and explanation after reload`
- **Original command:** `ORKESTRATOR_E2E_PORT=53136 mise run test:logged -- --name merge-browser-owned -- mise run test:browser` (nine workers; 284 passed, 79 skipped, 69 failed across the suite).
- **Failure:** 30-second navigation deadlines; the one-worker owning-file rerun against the same server also failed at `page.goto` (mobile) and `page.reload` (desktop).
- **Isolated rerun:** Fresh free-port fixture server, `mise run test:logged -- --name merge-plan-usage-fresh -- bunx playwright test --config e2e/playwright.config.ts e2e/PlanUsage.spec.ts --workers=1 --output output/playwright/merge-plan-usage-fresh` with `ORKESTRATOR_E2E_PORT` set to that port: both viewport projects passed unchanged, exit 0, 12.0 s.
- **Evidence:** `orkestrator-test-run.sW5og1/merge-browser-owned.log.gz` and `orkestrator-test-run.bVtMCX/merge-plan-usage-browser.log.gz`.
- **Assessment:** Intermittent navigation under shared-host/fixture load; exact cause unconfirmed. The other browser-suite failures remain separate validation limitations.
