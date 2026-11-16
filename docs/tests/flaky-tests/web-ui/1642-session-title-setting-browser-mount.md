# Session-title setting missing during browser mount

- **ID:** 1642
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `Session titles discloses where a first message goes and persists its choice`
- **Owner:** `e2e/GlobalSettings.spec.ts`, mobile-chromium project.
- **Command:** `mise run test:logged -- --name review-settings-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/GlobalSettings.spec.ts --workers=1`.
- **Failure:** the first `getByRole("combobox", { name: "Session titles" })` assertion found no element within 5000 ms. The complete owner reported seven passed and one failed in 80.0 s. Both Claude background-limit save/remount/reset regressions passed.
- **Unchanged complete-owner rerun:** the exact command above passed all eight cases in 80.8 s. No source, assertion, timeout, retry or worker-count changes were made to this owner between these runs.
- **Evidence:** failing output is `/tmp/orkestrator-test-run.XgPx6H/review-settings-browser.log.gz`; passing output was removed by `test:logged`.
- **Context:** full repository tests and isolated browser validation also ran on this host. Load averages observed around this work ranged from 23 to 43. Delayed renderer mounting is a hypothesis, not a confirmed cause; no failure screenshot or DOM snapshot establishes it.

## Triage note (2026-11-15)

Class A candidate (Playwright's default 5 s assertion / 30 s test deadline expiring on a loaded host). Not changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`expect.timeout` and `timeout`), but that config is shared with every group's component browser specs, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced; the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** every recorded failure is a Playwright default deadline
  expiring on a loaded host while the spec waited on a real signal: the `Session titles` combobox absent within the 5 s `expect` default while the settings page mounted.
  No wrong value, crash or lost input is recorded. `e2e/GlobalSettings.spec.ts` passes no smaller
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
