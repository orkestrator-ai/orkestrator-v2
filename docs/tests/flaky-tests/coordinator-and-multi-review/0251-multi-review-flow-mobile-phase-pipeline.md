# Multi Review flow phase pipeline case fails in the parallel browser suite

- **ID:** 0251
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `[mobile-chromium] renders every phase as a pipeline without overlapping nodes`
- **Owning file:** `e2e/MultiReviewFlow.spec.ts:45`
- **Original command:** `mise run test:browser` on
  `overnight-opencode-skew-guard-854f012a1bb0` (browser fixture-server ownership
  guard; no Multi Review code changed).
- **Failure:** the case failed; the assertion text was not kept.
- **Suite counts:** 254 passed, 61 skipped and 3 failed across 318 cases
  (2.8 m); the other two failures were case 0173.
- **Isolated owning-file rerun:** `bunx playwright test --config
  e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts e2e/MultiReviewFlow.spec.ts
  --workers=1` passed (21 passed, 5 skipped). A repeat of the full browser suite
  also passed (257 passed, 61 skipped).
- **Hypothesis:** the case visits each phase in turn, so it runs longer than
  its neighbours and may exceed a deadline under parallel load; not established.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.

## Recurrence during unread-toast fixes (2026-10-16)

- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`.
- **Worker configuration:** nine Playwright workers; the non-iOS suite was also running.
- **Failure:** both mobile and desktop cases exceeded the 30 s test deadline in
  `page.goto`, waiting for `load` on the `cancelled` and `failed` phases,
  respectively. No Multi Review implementation or test changed.
- **Suite counts:** 320 total, 256 passed, 61 skipped, three failed in 2.7 m;
  the third failure was native branch suggestion selection.
- **Isolated owning-file rerun:** `mise run test:logged -- --name
  multi-review-browser-isolated -- bunx playwright test --config
  e2e/playwright.config.ts e2e/MultiReviewFlow.spec.ts` passed in 15.2 s.
- **Hypothesis:** the repeat supports a load-sensitive navigation deadline;
  the root cause remains unconfirmed. Status stays open.

## Triage note (2026-11-15)

Class A candidate. A navigation (`page.goto`/`page.reload`) or step used up Playwright's 30 s test deadline, or an assertion hit the 5 s `expect` default, while the host was loaded. The spec has no fixed sleep or ad-hoc wall-clock check of its own on the failing path. Nothing was changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`timeout` and `expect.timeout`), but every group's component specs share that config, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced, because the browser suite was not run. Stays `open`.

Later the same day `e2e/playwright.config.ts` raised its defaults to `timeout: 120_000` and `expect: { timeout: 30_000 }`, which resolved the same test's recorded deadlines in [0254](0254-multi-review-flow-goto-timeout-under-load.md). This case is not resolved with it: its first observation kept no failure text, so not every recorded failure is shown to be a default deadline. Close it as a duplicate of 0254 if the next failure of this test is a deadline, or record the new text here.
