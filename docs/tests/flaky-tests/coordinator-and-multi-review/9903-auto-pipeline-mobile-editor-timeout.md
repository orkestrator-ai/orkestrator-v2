# Auto-pipeline mobile editor timeout

- **ID:** 9903
- **Status:** open
- **Date observed:** 2026-11-09

Test: `Auto-pipeline ready and cancellation` in `e2e/AutoPipeline.spec.ts`, mobile-chromium.

Base: `c0b02ace0188988773bd540ed132d9f99d0529c5`. Reviewed head: `f816be10142dc5844469992c1473f0b297287d25`; observation includes uncommitted review repairs. No existing index row matches this owner, so this is a new case, not a counted recurrence.

Command: `mise run test:logged -- --name address-browser-rerun -- mise run test:browser`. Six workers. The editor's reordered Criterion 1 assertion exhausted the 30 s test deadline. The run was interrupted after multiple other specs failed: 13 failed, 30 passed, 6 interrupted, 9 skipped and 1658 not run. Evidence: `/tmp/orkestrator-test-run.KFqfJS/address-browser-rerun.log.gz`.

Owning-file rerun: `mise run test:logged -- --name address-auto-browser -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/AutoPipeline.spec.ts --workers=2`. All 12 desktop/mobile cases passed in 68.4 s. No timeout was increased and no assertion was removed.

Cause remains unknown. Several unrelated fixture interactions and reloads also timed out in the broad run; that observation does not establish an environmental exemption or rule out a product race.

## Additional observation, 2026-11-09

Observed on `auto-pipeline-environment-adfad114968b-r1`, base
`c0b02ace0188988773bd540ed132d9f99d0529c5`, with repairs after `9ec966875`.
`address4-focused-browser` ran the owning spec with two workers: 11 passed,
one failed in 87.5 s. The mobile ready case exhausted its 30 s deadline at
`e2e/AutoPipeline.spec.ts:55`, waiting to click Cancel after its screenshot.
Evidence: `/tmp/orkestrator-test-run.koCpBn/address4-focused-browser.log.gz`.
The identical owning-spec rerun `address4-browser-owner-rerun` passed all
12 cases in 41.6 s. Neither the timeout nor assertions changed. This confirms
an intermittent owner failure, not its cause; no environmental exemption is
claimed for the incomplete broad browser run. The recurrence tool was run
against the base before recording this observation.
