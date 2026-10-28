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

## Rewind review validation, 2026-10-28

Preparation for the pipeline rewind follow-ups reproduced the mobile gap at
57 px in `mise run test:browser`. The complete unchanged ToolGroupFold owner
passed all 38 cases across both viewports with one worker in a combined
42-case run with AgentLaunchDialog (162.6 s). The two failures in that run
were the previously established native branch suggestion failure (`rel`
instead of `release/2.0`), also recorded in aggregate case 0958.

Command: `ORKESTRATOR_E2E_PORT=24982 mise run test:logged -- --name recorded-browser-failures -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts e2e/ToolGroupFold.spec.ts --workers=1`.
Evidence: `orkestrator-test-run.AJChkk/recorded-browser-failures.log.gz` under
the host temporary directory. No assertion, timeout or skip changed.

## Coordinator PR-tab validation, 2026-10-28

The browser suite on branch `pr-review-process-8b9b35a14ee2-r1` (backend
coordinator prompts and PR commands; no web or fixture code) had a
ToolGroupFold failure. With nine workers and five repetitions at load average
40–86, the merged branch repeated the mobile gap at 57 px, and detached
`origin/main` `4588fa511` repeated it twice at 57 px in ten repetitions (with
0793's line-153 case). Command:
`ORKESTRATOR_E2E_PORT=<free port> bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --repeat-each=10 --workers=9`.
Evidence: `.orkestrator/fix-validation/r2/baseline-toolgroupfold-2.log` and
`branch-toolgroupfold.log` in that checkout. No assertion, timeout or skip
changed.
