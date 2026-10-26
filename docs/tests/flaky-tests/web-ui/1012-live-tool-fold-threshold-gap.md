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
