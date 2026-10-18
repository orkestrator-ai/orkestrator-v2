# Plan usage browser reload timeout

- **ID:** 0495
- **Status:** open
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
