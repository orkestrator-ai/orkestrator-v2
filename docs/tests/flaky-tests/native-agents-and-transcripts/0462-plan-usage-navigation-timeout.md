# Browser plan-usage navigation timeout

- **ID:** 0462
- **Status:** resolved
- **Date observed:** 2026-10-18
- **File:** `e2e/PlanUsage.spec.ts`
- **Test:** `stale platform and account quotas retain their timestamp and explanation after reload`
- **Original command:** `ORKESTRATOR_E2E_PORT=53136 mise run test:logged -- --name merge-browser-owned -- mise run test:browser` (nine workers; 284 passed, 79 skipped, 69 failed across the suite).
- **Failure:** 30-second navigation deadlines; the one-worker owning-file rerun against the same server also failed at `page.goto` (mobile) and `page.reload` (desktop).
- **Isolated rerun:** Fresh free-port fixture server, `mise run test:logged -- --name merge-plan-usage-fresh -- bunx playwright test --config e2e/playwright.config.ts e2e/PlanUsage.spec.ts --workers=1 --output output/playwright/merge-plan-usage-fresh` with `ORKESTRATOR_E2E_PORT` set to that port: both viewport projects passed unchanged, exit 0, 12.0 s.
- **Evidence:** `orkestrator-test-run.sW5og1/merge-browser-owned.log.gz` and `orkestrator-test-run.bVtMCX/merge-plan-usage-browser.log.gz`.
- **Assessment:** Intermittent navigation under shared-host/fixture load; exact cause unconfirmed. The other browser-suite failures remain separate validation limitations.

## Resolution (2026-11-15)

- **Root cause:** a default Playwright deadline on a loaded host while waiting on a real signal. `page.goto` and `page.reload` exceeded Playwright's 30 s default test timeout under shared-host and fixture-server load (the one-worker rerun against the same loaded server failed the same way; a fresh server passed). Navigations have no own timeout, so the test budget bounded the wait. The spec sets no `test.setTimeout` and passes no timeout to either navigation.
- **Fix:** `e2e/playwright.config.ts` (the component browser suite, `mise run test:browser`) now sets `timeout: 120_000` (was Playwright's 30 s default) and `expect: { timeout: 30_000 }` (was 5 s). Both are hang watchdogs on real signals, not speed checks.
- **Reproduced:** no — the recorded failure was not reproduced before the fix. The evidence is a rerun of the component specs that had failed in a loaded run, with the new config: 112 passed. A raised budget is weaker evidence than a reproduced race.
- **Reopen:** a recurrence that hangs near the new budget (a navigation near 120 s, an assertion near 30 s) means the signal never arrives; reopen this case rather than raising the budget again.
