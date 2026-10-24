# Annotation destination layout navigation times out in the broad browser suite

- **ID:** 0784
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `destination titles and composer actions stay inside a 240px sidebar`, `destination titles and composer actions stay inside a 280px sidebar`, and `destination titles and composer actions stay inside a 360px sidebar` in `e2e/AnnotationDestinationLayout.spec.ts:21` (mobile-chromium).
- **Original command:** `ORKESTRATOR_E2E_PORT=18423 ORKESTRATOR_PUBLIC_E2E_PORT=18424 mise run test:logged -- --name annotation-browser -- mise run test:browser`.
- **Worker configuration:** Playwright reported 682 tests using nine workers, with other checkouts running browser, Electron and aggregate tests on the same host.
- **Failure:** All three mobile cases exceeded the 30,000 ms test timeout in `page.goto("/annotation-destination-layout")`, waiting for `load`; no layout assertion had run.
- **Suite counts:** The run was interrupted after widespread navigation timeouts: 50 failed, nine interrupted, 50 skipped, 524 did not run, 49 passed (6.3 minutes). The earlier default-port attempt refused another checkout's fixture server before collecting tests.
- **Isolated rerun:** `ORKESTRATOR_E2E_PORT=18423 mise run test:logged -- --name annotation-layout -- bunx playwright test --config e2e/playwright.config.ts e2e/AnnotationDestinationLayout.spec.ts --workers=1` → all six cases passed, complete owning file, 75.7 seconds including fixture-server setup.
- **Hypothesis:** Shared host contention is a candidate: observed load averages were 88.36, 100.88 and 72.19, and the aggregate runner reported 18 of 18 host worker slots reserved. The navigation timeouts also affected unrelated files. This does not establish the precise cause; the isolated pass used one worker. Test logic, assertions and timeout budgets were unchanged between the failing and passing runs.
- **Artifacts:** Failing browser log and summary were retained under `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.2cl2Vt/` (`annotation-browser.log.gz`, `summary.json`).
