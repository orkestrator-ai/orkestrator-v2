# Annotation Home preview hidden after reload

- **ID:** 0272
- **Status:** open
- **Date observed:** 2026-10-17
- **Test:** `Home native preview hides beneath board panels and returns without losing its tab`
  in `e2e/agent-testing/web-annotations-electron.spec.ts`.
- **Original command:** `mise run test:logged -- --name agent-electron -- mise run test:agent:electron`.
  Playwright used one worker; the non-iOS repository suite was also active.
- **Failure:** `visiblePreview` remained false after renderer reload and the
  explicit Home selection; the 30-second poll failed (then line 717).
- **Suite counts:** 3 passed, 2 failed, 1 skipped, 9 did not run. The other
  failure was the separately addressed independent-window focus assertion.
- **Isolated rerun:** `mise run test:logged -- --name annotation-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts`.
  All 10 tests passed in 68.3 seconds. The Home test and its assertions were
  unchanged. Repository validation remained active; the other Electron spec
  briefly ran concurrently during this diagnostic rerun.
- **Evidence:** failure log
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.MX48PV/agent-electron.log.gz`;
  rerun counts in `output/agent-testing/electron-smoke/electron/results.json`.
- **Hypothesis:** asynchronous renderer initialization may overwrite the explicit
  Home selection immediately after `waitForApi`; not confirmed. No timeout or
  assertion was relaxed, and no test was skipped.

## Recurrence during preview tunnel close-drain validation (2026-10-17)

- **Original command:** `mise run test:logged -- --name agent-electron -- mise run test:agent:electron`.
  One Playwright worker; the full non-iOS suite was also active, with groups
  waiting for shared host capacity.
- **Failure:** the same Home preview test timed out at the 30-second
  `visiblePreview` poll after renderer reload (line 718), expected `true`,
  received `false`. The run took 105.4 seconds: 4 passed, 1 failed, 1 skipped,
  9 did not run.
- **Isolated rerun:** `mise run test:logged -- --name electron-annotations-isolated -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/web-annotations-electron.spec.ts --workers=1`.
  All 10 unchanged tests passed; the logged command took 66.2 seconds. The
  non-iOS suite remained active.
- **Evidence:** original failure log
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vrId94/agent-electron.log.gz`;
  isolated counts in `output/agent-testing/electron-smoke/electron/results.json`.
- **Hypothesis:** consistent with the existing renderer-initialization race;
  this run does not establish a cause. No assertion or timeout was changed.

## Root cause and fix (2026-10-18)

- **Recurrence:** in the full Electron suite during the real-Electron service
  preview qualification (load average 34 to 56), and this time **alone** too:
  `bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts`
  failed the Home test at the same line-718 poll (1 failed, 9 did not run, 35.2 s).
- **Cause:** a startup dialog ("Continue Without GitHub CLI", which an
  agent-test profile shows on every start) can reopen after the renderer
  reload, and an open dialog correctly hides native previews.
  `dismissStartupDialogs` closes it through Playwright locator handlers. Those
  run only before a locator action or assertion, never during the
  `app.evaluate` poll, so nothing closed the dialog. The new
  `service-preview-electron.spec.ts` showed the same symptom. An accessibility
  snapshot taken when its poll timed out (a locator call, so the handler ran)
  showed the view visible immediately afterwards.
- **Fix:** each `visiblePreview` read first runs
  `expect(getByRole("dialog")).toHaveCount(0, { timeout: 1_000 })`, which
  gives the handlers a turn. No timeout was loosened and no assertion removed.
  The service-preview spec's visibility helper does the same.
- **Verification:** with the fix, the owning spec passed 10/10 twice alone
  (1.5 and 1.1 min) on the same loaded host, right after the failing alone
  run. The service-preview spec, which hit the symptom before its equivalent
  fix, passed 13 consecutive runs after it.

## Reopened: recurrence in the 4340 Electron rerun on macOS — 2026-11-13

- **Branch and base:** Branch `electron-suite-rerun-4896909ed3cc-r1`, base `17d28238c` (to-do 4340 task 5, which changes no desktop or Electron spec code). `mise run flaky:recurrence -- 0272 --base 17d28238c`: resolved, and the base contains its fix (`2a13546f8b`), so this is a real recurrence and the case is reopened.
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=electron-4340 mise run test:logged -- --name agent-electron -- mise run test:agent:electron` (one Playwright worker, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`), on this Mac (macOS 27.2, Apple silicon) shared with nine other builds; the failure snapshot's CPU meter read 100 %.
- **Failure:** a different step from the 2026-10-18 cause: after selecting the project row and the **Home** tab, `getByRole("textbox", { name: "Browser address" })` was not found within 5 s (`web-annotations-electron.spec.ts:842`), before the reload the earlier fix covers. Test 7.7 s; the file's 18 later serial cases did not run. Suite: 43 passed, 4 failed, 6 skipped, 25 not run (serial cases behind a failure), 25.9 min.
- **Owning-file rerun:** `ORKESTRATOR_AGENT_TEST_RUN_ID=electron-4340-solo-web-annotations-electron mise run test:logged -- --name solo-web-annotations-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts web-annotations-electron.spec.ts` passed the complete unchanged owner (17 passed, 2 skipped, 115.7 s).
- **Evidence:** `orkestrator-test-run.2kT16D/agent-electron.log.gz` below the host temporary directory; results and traces under `output/agent-testing/electron-4340/electron/`; rerun under `output/agent-testing/electron-4340-solo-web-annotations-electron/electron/`.
- **Hypothesis:** the Home tab's browser surface renders later than 5 s after the click on a saturated host; not established. No assertion, timeout or skip changed.

