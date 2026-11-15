# Plan usage browser reload timeout

- **ID:** 0495
- **Status:** resolved
- **Date observed:** 2026-10-18
- **Owning file:** `e2e/PlanUsage.spec.ts:3`
- **Test:** `[desktop-chromium] stale platform and account quotas retain their timestamp and explanation after reload`
- **Original command:** `mise run test:logged -- --name merge-browser -- mise run test:browser`
- **Worker configuration:** Nine Playwright workers, mobile and desktop projects, alongside the full non-iOS suite and other host work.
- **Failure:** `page.reload` exceeded the 30,000 ms test deadline at line 9 while waiting for the load event. The initial quota assertions had completed.
- **Suite counts:** 304 passed, 80 skipped, 48 failed across 432 scheduled cases; exit 1 after 716.6 seconds. Other browser failures are not established as flakes by this isolated rerun.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.0TpONG/merge-browser.log.gz` and `output/playwright/test-results/PlanUsage-stale-platform-a-424bb-nd-explanation-after-reload-desktop-chromium/trace.zip`.
- **Isolated rerun:** `ORKESTRATOR_E2E_PORT=61223 mise run test:logged -- --name merge-plan-usage-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/PlanUsage.spec.ts --workers=1 --output output/playwright/merge-plan-usage` passed both projects unchanged, exit 0, in 57.5 seconds.
- **Hypothesis:** Host contention or fixture-server contention delayed navigation completion. The host load average exceeded 100 during the aggregate run; that observation does not establish a narrower cause. No assertion, deadline, or skip changed.

## Resolution (2026-11-15)

- **Root cause:** a default Playwright deadline on a loaded host while waiting on a real signal. `page.reload()` waiting for `load` exceeded Playwright's 30 s default test timeout at a host load average above 100. Navigations have no own timeout, so the test budget bounded the wait. The spec sets no `test.setTimeout` and passes no timeout to the reload.
- **Fix:** `e2e/playwright.config.ts` (the component browser suite, `mise run test:browser`) now sets `timeout: 120_000` (was Playwright's 30 s default) and `expect: { timeout: 30_000 }` (was 5 s). Both are hang watchdogs on real signals, not speed checks.
- **Reproduced:** no — the recorded failure was not reproduced before the fix. The evidence is a rerun of the component specs that had failed in a loaded run, with the new config: 112 passed. A raised budget is weaker evidence than a reproduced race.
- **Reopen:** a recurrence that hangs near the new budget (a navigation near 120 s, an assertion near 30 s) means the signal never arrives; reopen this case rather than raising the budget again.
