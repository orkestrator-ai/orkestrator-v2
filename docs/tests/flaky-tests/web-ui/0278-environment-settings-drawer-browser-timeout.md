# Environment settings drawer does not open in the parallel browser suite

- **ID:** 0278
- **Status:** resolved
- **Date observed:** 2026-10-17
- **File:** `e2e/EnvironmentSettingsDrawer.spec.ts`.
- **Tests:** `environment settings opened from the projects drawer are usable on a phone` and `closing drawer-opened settings with the keyboard returns focus to the drawer trigger` (mobile Chromium).
- **Original command:** `mise run test:logged -- --name renderer-browser -- mise run test:browser` (nine workers, alongside repository and live Docker validation).
- **Failure:** both waited five seconds for the Environment Settings dialog after selecting Settings, but it did not appear.
- **Suite result:** 324 passed, 69 skipped, three failed in 183.5 seconds; the third failure was the design-canvas timeout in case 0174.
- **Owning-file rerun:** `mise run test:logged -- --name settings-browser-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/EnvironmentSettingsDrawer.spec.ts --workers=1` passed unchanged in 6.2 seconds (two passed, two desktop-only skips).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.8XBgi1/renderer-browser.log.gz`.
- **Assessment:** isolated pass confirms intermittence; root cause is unconfirmed. No implementation, assertion, timeout or skip changed.


## Landing-page main merge recurrence — 2026-10-18

`ORKESTRATOR_E2E_PORT=49295 ORKESTRATOR_PUBLIC_E2E_PORT=49296 mise run test:logged -- --name merge-browser-isolated-ports -- mise run test:browser` reported 303 passed, 80 skipped and 49 failed with nine workers alongside other host validation. This owner failed in:

- `environment settings opened from the projects drawer are usable on a phone`
- `closing drawer-opened settings with the keyboard returns focus to the drawer trigger`

All 21 failing owners, including this unchanged file, passed with one worker in 428.8 seconds (exit 0). The complete rerun command, individual failure messages and evidence paths are in [0382](0382-component-browser-parallel-load.md). No timeout, assertion, skip or owning source changed.

## Environment settings drawer: session history review — 2026-10-31

The nine-worker component run (`mise run test:logged -- --name review-browser -- mise run test:browser`)
repeated this owner's failure: 983 passed, 106 skipped and eleven failed overall.
The complete unchanged owner passed in the subsequent one-worker, multi-owner
run (147 passed, three skipped, two unrelated AgentLaunchDialog failures).
This was a combined owner run, not a new standalone qualification. No assertion,
deadline or implementation changed. Exact commands and evidence are recorded in
[session history validation](../aggregate-validation-runs/1166-session-titles-0006-validation.md#structured-review-fixes--2026-10-31).

## Settings layout review — 2026-10-31

- **Original command:** `ORKESTRATOR_E2E_PORT=18237 ORKESTRATOR_PUBLIC_E2E_PORT=18238 mise run test:logged -- --name browser -- mise run test:browser`, implementation commit `d639571b2`, nine Playwright workers alongside other validation on the shared host.
- **Aggregate result:** 982 passed, 108 skipped, 14 failed; exit 1 in 1388.6 seconds logged. The component failure short-circuited the public-site command. All new layout measurement cases passed.
- **Settings failures:** both mobile drawer-opening cases in `e2e/EnvironmentSettingsDrawer.spec.ts` failed to find `Projects and environments` at the five-second visibility deadline, before opening Settings. `Claude background limit persists across reload and clears when reset to default` in `e2e/GlobalSettings.spec.ts` exceeded the 30-second test deadline during its final `page.reload()`.
- **Complete owning-file confirmation:** the following one-worker run passed (exit 0, 44.7 seconds logged), including all cases in both affected owners and the two layout specs. The drawer and GlobalSettings spec sources were unchanged by this review; the GlobalSettings fixture gained only the Debug/Platforms responses and section selector needed by the new layout coverage. Passing raw output was removed by the bounded logger.

```sh
ORKESTRATOR_E2E_PORT=18237 mise run test:logged -- --name settings-review-final-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/EnvironmentSettingsDrawer.spec.ts e2e/GlobalSettings.spec.ts e2e/FullscreenSettingsLayout.spec.ts e2e/SettingsPageLayout.spec.ts --workers=1
```

- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.DCiIXp/browser.log.gz`.
- **Assessment:** the drawer and settings reload failures are intermittent in this observation. Host contention is a hypothesis, not an established cause; no assertion, timeout or skip was changed. The full browser command remains failed.

## Triage note (2026-11-15)

Class A candidate (Playwright's default 5 s assertion / 30 s test deadline expiring on a loaded host). Not changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`expect.timeout` and `timeout`), but that config is shared with every group's component browser specs, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced; the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** every recorded failure is a Playwright default deadline
  expiring on a loaded host while the spec waited on a real signal: the Environment Settings dialog or the `Projects and environments` drawer not visible within the 5 s `expect` default, and (in the 2026-10-31 run) a `GlobalSettings.spec.ts` `page.reload()` exceeding the 30 s test default.
  No wrong value, crash or lost input is recorded. `e2e/EnvironmentSettingsDrawer.spec.ts` passes no smaller
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
