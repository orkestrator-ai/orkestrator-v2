# Multi Review flow phase pipeline case fails in the parallel browser suite

- **ID:** 0249
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
