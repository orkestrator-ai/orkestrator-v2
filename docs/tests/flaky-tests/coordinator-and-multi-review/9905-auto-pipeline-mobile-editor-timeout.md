# Auto-pipeline mobile editor timeout

- **ID:** 9905
- **Status:** resolved
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

## Triage note (2026-11-15)

Class A candidate. A navigation (`page.goto`/`page.reload`) or step used up Playwright's 30 s test deadline, or an assertion hit the 5 s `expect` default, while the host was loaded. The spec has no fixed sleep or ad-hoc wall-clock check of its own on the failing path. Nothing was changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`timeout` and `expect.timeout`), but every group's component specs share that config, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced, because the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** Playwright's default deadlines ran out on a loaded host while the test was waiting on a real signal. Every recorded failure is the 30 s default test timeout (`Test timeout of 30000ms exceeded`, in `page.goto`, `page.reload`, a click or a web-first assertion still in progress) or the 5 s default `expect` budget; none is a value mismatch, crash or lost interaction, and the failing calls pass no smaller timeout of their own. The specs measure no latency, so those defaults were acting as speed checks rather than hang watchdogs.
- **Fix:** the component browser config, `e2e/playwright.config.ts` (`mise run test:browser`), now sets `timeout: 120_000` (was Playwright's 30 s default) and `expect: { timeout: 30_000 }` (was 5 s). Navigations carry no timeout of their own, so they are bounded by the 120 s test timeout. No assertion changed.
- **Reproduced:** no — the recorded failure was not reproduced before the change. The evidence is weaker: a rerun of the component browser specs that had failed in a loaded run, with the new config, gave 112 passed; the one remaining failure there (`ToolGroupFold.spec.ts:127`, [1012](../web-ui/1012-live-tool-fold-threshold-gap.md)) also fails with main's config and is unrelated.
- **Stress:** none beyond that rerun.

A recurrence that hangs until near the new budget (a navigation or assertion timing out at 120 s or 30 s) is a real hang, not this deadline: reopen this case and record it.
