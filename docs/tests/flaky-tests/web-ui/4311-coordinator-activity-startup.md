# Coordinator activity browser fixture startup

Renumbered from 4043 to 4311 to preserve the HTML preview case on main.

- **ID:** 4311
- **Status:** resolved
- **Date observed:** 2026-11-04

In `e2e/CoordinatorActivity.spec.ts` (desktop Chromium), `a coordinator's activity shows on its tab and its project heading` and `the tab's spinner follows its outline, unclipped, on the shared timeline` timed out waiting for the coordinator working outline (5 seconds). The tests were unchanged by this focus repair.

Original command: `mise run test:logged -- --name focus-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/FocusVisibility.spec.ts e2e/GlobalStyles.spec.ts e2e/WorkspaceBarHeight.spec.ts e2e/CoordinatorActivity.spec.ts --workers=4`. Result: 57 passed, 7 skipped, 2 failed, 36.9 seconds. Evidence: `/tmp/orkestrator-test-run.ODyaFS/focus-browser.log.gz`.

Owning-file isolated rerun: `mise run test:logged -- --name coordinator-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/CoordinatorActivity.spec.ts --project=desktop-chromium --workers=1`. Exit 0, 24.8 seconds. No assertions were relaxed or tests skipped to obtain the passing rerun. A cold fixture load under parallelism is a hypothesis; the underlying cause remains unconfirmed.

The original four-worker command later passed unchanged (33.3 seconds). An intervening attempt overlapped another component-browser invocation using the same output directory and fixture server, producing trace-file ENOENT and connection failures; that attempt is infrastructure interference, not additional evidence of this flake.

## Triage note (2026-11-15)

Class A candidate (Playwright's default 5 s assertion / 30 s test deadline expiring on a loaded host). Not changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`expect.timeout` and `timeout`), but that config is shared with every group's component browser specs, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced; the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** every recorded failure is a Playwright default deadline
  expiring on a loaded host while the spec waited on a real signal: the coordinator working outline not visible within the 5 s `expect` default.
  No wrong value, crash or lost input is recorded. `e2e/CoordinatorActivity.spec.ts` passes no smaller
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
