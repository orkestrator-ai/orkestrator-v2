# Auto-pipeline mobile editor timeout

- **ID:** 9903
- **Status:** open
- **Date observed:** 2026-11-09

Test: `Auto-pipeline ready and cancellation` in `e2e/AutoPipeline.spec.ts`, mobile-chromium.

Base: `c0b02ace0188988773bd540ed132d9f99d0529c5`. Reviewed head: `f816be10142dc5844469992c1473f0b297287d25`; observation includes uncommitted review repairs. No existing index row matches this owner, so this is a new case, not a counted recurrence.

Command: `mise run test:logged -- --name address-browser-rerun -- mise run test:browser`. Six workers. The editor's reordered Criterion 1 assertion exhausted the 30 s test deadline. The run was interrupted after multiple other specs failed: 13 failed, 30 passed, 6 interrupted, 9 skipped and 1658 not run. Evidence: `/tmp/orkestrator-test-run.KFqfJS/address-browser-rerun.log.gz`.

Owning-file rerun: `mise run test:logged -- --name address-auto-browser -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/AutoPipeline.spec.ts --workers=2`. All 12 desktop/mobile cases passed in 68.4 s. No timeout was increased and no assertion was removed.

Cause remains unknown. Several unrelated fixture interactions and reloads also timed out in the broad run; that observation does not establish an environmental exemption or rule out a product race.
