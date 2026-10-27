# a live group crossing the fold threshold folds into its line with no-preference motion

- **ID:** 1012
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `a live group crossing the fold threshold folds into its line with no-preference motion`
- **File:** `e2e/ToolGroupFold.spec.ts:79`
- **Original command:** `mise run test:browser`, nine browser workers.
- **Failure:** Mobile fold-gap maximum was 80 px instead of at most 2 px at line 147.
- **Suite counts:** 770 passed, three failed, 103 skipped across 876 component cases.
- **Isolated rerun:** `mise run test:logged -- --name browser-tool-fold-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1` passed the complete unchanged owning file (77.9 s).
- **Evidence:** `orkestrator-test-run.pU67Df` below the host temporary directory.
- **Hypothesis:** The post-fold geometry sample can observe an intermediate layout under parallel browser load; the unchanged full owner passes with one worker. Not confirmed; no assertion, timeout or skip changed.

## Recurrence during search review fixes, 2026-10-27

The nine-worker component run reproduced the mobile threshold gap: 57 px
against a 2 px limit. The complete unchanged ToolGroupFold owner then passed
both viewports in a one-worker, four-owner rerun (the combined command failed
in other owners). Aggregate: 790 passed, 103 skipped, five failed; owner batch:
83 passed, 20 skipped, five failed. Exact commands and artifacts are recorded
in [1126](../aggregate-validation-runs/1126-cross-machine-search-validation-workspace-failures.md#review-fix-validation-2026-10-27).
Status remains open; no assertion, timeout, or skip changed.
