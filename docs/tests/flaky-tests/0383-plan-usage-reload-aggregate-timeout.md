# Plan usage reload times out in the aggregate browser suite

- **ID:** 0383
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `stale platform and account quotas retain their timestamp and explanation after reload`
- **File:** `e2e/PlanUsage.spec.ts:3`
- **Original command:** `ORKESTRATOR_E2E_PORT=50764 mise run test:logged -- --name merge-browser-own-port -- mise run test:browser`
- **Worker configuration:** Nine Playwright workers, alongside the repository suite and an isolated browser profile on the shared macOS host.
- **Failure:** The mobile case exceeded 30 seconds in `page.reload()` at line 9, waiting for `load` after reaching `/global-settings?plan-usage=1`. The desktop case passed. The suite reported 291 passed, 62 failed and 79 skipped in 15.2 minutes; many other failures also involved navigation deadlines.
- **Isolated rerun:** `mise run test:logged -- --name merge-plan-usage-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/PlanUsage.spec.ts --workers=1 --output=output/playwright/merge-plan-usage-alone`, with a free `ORKESTRATOR_E2E_PORT`, passed both unchanged cases (exit 0, 10.0 seconds logged). A preceding one-worker run including `GlobalSettings.spec.ts` and `AgentUsage.spec.ts` also passed.
- **Evidence:** `orkestrator-test-run.B0QB3n/merge-browser-own-port.log.gz` below the platform temporary directory; original traces are under `output/playwright/test-results/`.
- **Hypothesis:** Aggregate browser or host scheduling may delay reload completion. The isolated pass establishes intermittent behavior, not its root cause. No assertion, timeout or skip changed.
