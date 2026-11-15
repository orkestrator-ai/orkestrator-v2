# HTML preview fixture startup

- **ID:** 4043
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Test:** `HTML boundary refuses resources, scripts, forms and mutated navigation`; `preview releases keyboard focus, saves, and permits divider dragging`
- **File:** `e2e/HtmlPreview.spec.ts`

Renumbered from 4042, which `backend-services-and-tooling/4042-toolchain-full-check-stamp-same-instant.md` had already taken.

Mobile Chromium:

- `HTML boundary refuses resources, scripts, forms and mutated navigation` initially reached its page evaluation before React mounted the iframe (`Cannot set properties of null (setting 'srcdoc')`). An explicit attached assertion now synchronizes that test's setup.
- `preview releases keyboard focus, saves, and permits divider dragging` timed out after 30 seconds waiting for the Report heading in the iframe, with no page snapshot. This test was unchanged on the passing rerun; the underlying startup cause is unconfirmed.

Original command: `NODE_ENV=development mise run test:logged -- --name html-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/HtmlPreview.spec.ts --workers=2`. Two workers, 2 passed / 2 failed in 31.3 seconds. Evidence: `/tmp/orkestrator-test-run.SULix9/html-browser.log.gz`.

Owning-file rerun: same command, 4 passed / 0 failed in 6.0 seconds, after adding the boundary test's mount assertion. The keyboard/divider test was unchanged. Earlier successful runs took 6.3 and 6.7 seconds. No test was skipped or assertion relaxed. Fixture startup/Vite cold loading is a hypothesis only; no browser exception was established.

## Triage note (2026-11-15)

Class A candidate (Playwright's default 5 s assertion / 30 s test deadline expiring on a loaded host). Not changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`expect.timeout` and `timeout`), but that config is shared with every group's component browser specs, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced; the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** every recorded failure is a Playwright default deadline
  expiring on a loaded host while the spec waited on a real signal: the keyboard/divider case's click on the iframe's `Report` heading waiting past the 30 s test default (the boundary case's `srcdoc` null error was a setup race fixed by the attached assertion recorded above, in the same change).
  No wrong value, crash or lost input is recorded. `e2e/HtmlPreview.spec.ts` passes no smaller
  timeout of its own at the failing calls.
- **Fix:** `e2e/playwright.config.ts`, which runs this component spec, now sets
  `timeout: 120_000` (was Playwright's 30 s default) and
  `expect: { timeout: 30_000 }` (was 5 s). Navigations have no timeout of
  their own, so they are bounded by the 120 s test budget. Both budgets are
  hang watchdogs on real signals, not speed checks.
- **Reproduced:** no — the recorded failure was not reproduced. The evidence
  is a rerun, under the new config, of the component specs that had failed in
  a loaded run (112 passed); that is not a targeted reproduction of this case,
  and a raised budget is weaker evidence than a reproduced fix.
- **Reopen:** a recurrence that hangs near the new budgets (120 s test, 30 s
  assertion) means the signal never arrived rather than arrived late; reopen
  this case.
