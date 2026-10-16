# Multi Review flow fixture misses the test timeout while loading under load

- **ID:** 0249
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `[desktop-chromium] › renders every phase as a pipeline without overlapping nodes`
- **Owning file:** `e2e/MultiReviewFlow.spec.ts:45`
- **Original command:** `mise run test:logged -- --name browser-suite -- mise run test:browser`
  on branch `mobile-layout-gaps`, while other environments ran test suites on
  the same host.
- **Failure:** `page.goto: Test timeout of 30000ms exceeded.` The fixture page
  never finished loading within the test's 30 s budget.
- **Suite counts:** 262 passed, 65 skipped, 1 failed (2.4 min).
- **Isolated reruns:** the test alone in `desktop-chromium` passed three times
  (10.2 s, 10.7 s and 9.8 s), and the whole owning file passed (16 cases,
  24.5 s).
- **Evidence:** `/tmp/orkestrator-test-run.oCvgRY/browser-suite.log.gz` and
  its `summary.json`.
- **Hypothesis:** the case needs about a third of its 30 s budget for
  `page.goto` alone, so a loaded host pushes it over. The change under test
  (how the mobile pane switcher hides panes) does not touch the Multi Review
  flow fixture. No assertion was skipped or weakened.
