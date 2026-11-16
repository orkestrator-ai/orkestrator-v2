# Plan usage reload times out in the aggregate browser suite

- **ID:** 0383
- **Status:** resolved
- **Date observed:** 2026-10-18
- **Test:** `stale platform and account quotas retain their timestamp and explanation after reload`
- **File:** `e2e/PlanUsage.spec.ts:3`
- **Original command:** `ORKESTRATOR_E2E_PORT=50764 mise run test:logged -- --name merge-browser-own-port -- mise run test:browser`
- **Worker configuration:** Nine Playwright workers, alongside the repository suite and an isolated browser profile on the shared macOS host.
- **Failure:** The mobile case exceeded 30 seconds in `page.reload()` at line 9, waiting for `load` after reaching `/global-settings?plan-usage=1`. The desktop case passed. The suite reported 291 passed, 62 failed and 79 skipped in 15.2 minutes; many other failures also involved navigation deadlines.
- **Isolated rerun:** `mise run test:logged -- --name merge-plan-usage-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/PlanUsage.spec.ts --workers=1 --output=output/playwright/merge-plan-usage-alone`, with a free `ORKESTRATOR_E2E_PORT`, passed both unchanged cases (exit 0, 10.0 seconds logged). A preceding one-worker run including `GlobalSettings.spec.ts` and `AgentUsage.spec.ts` also passed.
- **Evidence:** `orkestrator-test-run.B0QB3n/merge-browser-own-port.log.gz` below the platform temporary directory; original traces are under `output/playwright/test-results/`.
- **Hypothesis:** Aggregate browser or host scheduling may delay reload completion. The isolated pass establishes intermittent behavior, not its root cause. No assertion, timeout or skip changed.

## Resolution (2026-11-15)

- **Root cause:** a default Playwright deadline on a loaded host while waiting on a real signal. `page.reload()` waiting for `load` exceeded Playwright's 30 s default test timeout on a loaded host. Navigations have no own timeout, so the test budget bounded the wait. The spec sets no `test.setTimeout` and passes no timeout to the reload.
- **Fix:** `e2e/playwright.config.ts` (the component browser suite, `mise run test:browser`) now sets `timeout: 120_000` (was Playwright's 30 s default) and `expect: { timeout: 30_000 }` (was 5 s). Both are hang watchdogs on real signals, not speed checks.
- **Reproduced:** no — the recorded failure was not reproduced before the fix. The evidence is a rerun of the component specs that had failed in a loaded run, with the new config: 112 passed. A raised budget is weaker evidence than a reproduced race.
- **Reopen:** a recurrence that hangs near the new budget (a navigation near 120 s, an assertion near 30 s) means the signal never arrives; reopen this case rather than raising the budget again.
