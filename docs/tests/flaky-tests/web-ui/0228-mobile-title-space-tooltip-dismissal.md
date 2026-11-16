# Mobile title tooltip stays open after Space

- **ID:** 0228
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `[mobile-chromium] › e2e/MobileAppShellLayout.spec.ts:12 › long
  mobile titles stay between controls and support touch and keyboard dismissal`.
- **Failure:** at line 93, `getByRole("tooltip")` still matched one element
  after `title.press("Space")`, instead of zero, for the five-second assertion
  timeout.
- **Original command:** `mise run test:logged -- --name component-browser --
  mise run test:browser`, nine Playwright workers, alongside `mise run test`.
  Result: 197 passed, 57 skipped, 10 failed in 74 seconds. Nine other failures
  were trace-file ENOENT errors caused by an overlapping focused Playwright run
  clearing the shared output directory; they are not classified as flakes.
- **Isolated rerun:** `mise run test:logged -- --name mobile-browser-alone --
  bunx playwright test --config e2e/playwright.config.ts
  e2e/MobileAppShellLayout.spec.ts --workers 1` passed in 4.6 seconds (3 passed,
  3 skipped). The owning spec and production mobile layout were unchanged.
- **Full rerun:** `mise run test:logged -- --name component-browser-clean --
  mise run test:browser` passed in 60.8 seconds with no overlapping Playwright
  invocation.
- **Evidence:** `/tmp/orkestrator-test-run.SH0gZ2/component-browser.log.gz`.
- **Hypothesis:** tooltip focus/keyboard state may race under parallel host
  load. The isolated pass establishes intermittency, but does not establish
  the cause. The implementation changes the design-host client and unit-test
  coverage, not the mobile tooltip or its browser fixture.

## Triage note (2026-11-15)

Class A candidate (Playwright's default 5 s assertion / 30 s test deadline expiring on a loaded host). Not changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`expect.timeout` and `timeout`), but that config is shared with every group's component browser specs, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced; the browser suite was not run. Stays `open`.

## Triage note (2026-11-15, after the config change)

Follow-up: the hang-watchdog defaults this note deferred have now landed (`e2e/playwright.config.ts`: `timeout: 120_000`, `expect: { timeout: 30_000 }`), but this case stays `open`: the tooltip stayed open after `Space` for the whole wait, which points at a lost or mishandled keypress rather than a late signal; cause unclear.
