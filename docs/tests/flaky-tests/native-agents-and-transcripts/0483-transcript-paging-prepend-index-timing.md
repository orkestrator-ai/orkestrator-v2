# Transcript paging observes the previous row index after prepend

- **ID:** 0483
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `native: paging before prose holds the original tool position` (mobile Chromium)
- **File:** `e2e/TranscriptPaging.spec.ts:57`
- **Original command:** `ORKESTRATOR_E2E_PORT=50649 mise run test:logged -- --name merge-component-browser-two-workers -- bunx playwright test --config e2e/playwright.config.ts --workers=2`.
- **Workers:** two Playwright workers alongside the non-iOS aggregate, isolated browser validation and other worktrees.
- **Failure:** the tool's row index was still `1`, expected greater than the original `1`, after the offset-preservation poll passed.
- **Suite counts:** 357 passed, 80 skipped and three failed across 440 cases (957.8 s logged). The other owners were DesignCanvas and DiffViewerMobile (0382).
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=50649 mise run test:logged -- --name merge-transcript-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1 --output output/playwright/merge-browser-owners/TranscriptPaging` passed all eight unchanged cases, exit 0, in 63.9 s.
- **Evidence:** `orkestrator-test-run.5S9NY7/merge-component-browser-two-workers.log.gz` below the host temporary directory; Playwright failure under `output/playwright/test-results/TranscriptPaging-native-pa-48048--the-original-tool-position-mobile-chromium/`.
- **Assessment:** confirmed intermittent observation. Prepend/render timing remains a hypothesis; no source, assertion, timeout or skip changed.

## Claude revision-token third main merge — 2026-10-22

- **Original command:** `mise run test:logged -- --name revtok-main3-browser -- mise run test:browser`, with the default component-browser workers alongside the repository aggregate and Electron checks.
- **Failure:** the same mobile native paging case failed its offset-preservation poll at line 70: 244.5 px rather than less than 3 px within 5000 ms. This differs from the earlier row-index assertion in this case history. The component suite reported 398 passed, 81 skipped and one failed across 480 cases (3.5 minutes).
- **Unchanged whole owner:** `mise run test:logged -- --name revtok-main3-transcript-paging-owner-correct -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1` passed all eight cases in 44.9 s. An earlier command used a nonexistent root config and exited before discovering any tests; it is not validation evidence.
- **Evidence:** `orkestrator-test-run.9O0EhD/revtok-main3-browser.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent occurrence in the same scenario, with a different assertion; rendering timing remains a hypothesis. No implementation, assertion, timeout or skip changed.

## Recurring-work qualification main merge — 2026-10-22

- **Original command:** `mise run test:logged -- --name merge-browser -- mise run test:browser`, nine Playwright workers alongside the repository aggregate, Electron checks and Docker image build. Pre-merge HEAD was `61866a15b208019ee787038202be0e3381a42343`; merged main was `3b469e885`.
- **Failure:** desktop Chromium `native: paging before prose holds the original tool position` failed its offset-preservation poll at line 70: 244.5 px, expected less than 3 px within 5000 ms. Component coverage reported 410 passed, 85 skipped and three failed across 498 cases (253.8 s logged). The other two failures were native branch-suggestion selection in `AgentLaunchDialog.spec.ts`.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-transcript-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=1` passed all eight cases, exit 0 (43.7 s logged).
- **Evidence:** `orkestrator-test-run.S5weqt/merge-browser.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent offset-preservation failure. The owner and implementation were unchanged by this merge; no assertion, deadline or skip was changed.


## Session lifecycle review recurrence — 2026-10-23

The desktop native paging case saw prepend index 1 instead of an index greater than 1 during the nine-worker component suite. The complete unchanged owner passed separately with one worker in 47.2 seconds. Exact aggregate counts, owner command, and evidence are recorded in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#session-lifecycle-review-validation--2026-10-23). No assertion, timeout, or skip changed.

## Todo 0090 folded-group paging tests — 2026-10-25

- **Original command:** `ORKESTRATOR_E2E_PORT=14390 mise run test:logged -- --name transcript-paging-owner-4w -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts --workers=4`, on branch `todo-0090-held-place-drift` (this owner file with four new folded-group test scenarios across two projects: eight added project cases, 30 cases in all), on arktech-mini.
- **Failures:** two, both this scenario. Desktop native kept prepend index `1` (expected greater than `1`); mobile native's scrollTop stayed `0` (expected greater than 500). An earlier four-worker run of the same file that day failed mobile native once as well. The new folded-group cases passed in every run.
- **Suite counts:** 28 passed, 2 failed (43.6 s).
- **Owner reruns:** `-g "paging before prose" --repeat-each 3 --workers 4` passed 12 of 12 (26.4 s); the whole owner with `--workers=1` passed all 30 cases (111.0 s logged).
- **Assessment:** confirmed intermittent recurrence under parallel load. The fixture's default (unpaged) history is unchanged by this branch: the new `paged`, `stops` and `prompt` options default off. The index assertion failing while the offset held fits a page that never landed, as when the native tab's background poll retires a page in flight (transcript-scroll.md, Known limitations). That remains a hypothesis. No assertion, timeout or skip changed.
