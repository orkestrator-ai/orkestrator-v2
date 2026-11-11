# Design canvas Electron journey fails around the Docker reachability dialog

- **ID:** 4250
- **Status:** open
- **Date observed:** 2026-11-03
- **Test:** `design canvas opens, edits, exports, downloads, takes shortcuts and opens a host .orkdes in Electron`
- **File:** `e2e/agent-testing/design-canvas-electron.spec.ts:91`
- **Host:** beelink (Linux, ufw drops Docker's traffic to the host, so the backend's boot check reports `status=blocked` about 5.6 s after startup and opens the "Docker containers can't reach Orkestrator" modal). Load average 1 to 7 during the runs.
- **Revision:** branch for to-do [2181](../../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md), based on `main` at `4d9ff8690`.
- **Command, run alone with no display:**
  `env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1 bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts design-canvas-electron.spec.ts` (one worker, as the config sets).
- **Failure, at a different step each time:**
  - `TimeoutError: locator.getAttribute: Timeout 30000ms exceeded`, waiting for the `Zoom N%. Reset to 100%` button (`design-canvas-electron-journey.ts:74`, the `edit` step).
  - `Error: locator.click: Target page, context or browser has been closed`, with the call log showing the Close button of the reachability dialog's locator handler being retried while a `dialog-overlay` intercepts it.
  - `Error: expect(received).not.toBe(expected)` and `Error: expect(locator).toBeVisible() failed`.

## Observations

All 15 runs were on the same host on the same day, in the order they were made.

| Variant of `playwright.electron.config.ts` | Passed |
| --- | --- |
| With the branch's `globalSetup` (`electron-display-setup.ts`) | 2 of 7 |
| At `HEAD`, no `globalSetup` | 3 of 5 |
| With a `globalSetup` that does nothing | 1 of 3 |

The first runs happened to fail with the branch's `globalSetup` and pass without
it, which looked like a regression. An interleaved run of three each (`HEAD`,
no-op, branch) gave 1, 1 and 2 passes with the same mix of failures, so the
config is not the cause. Passing runs take about 15 s.

## Assessment

Intermittent by the registry's rule, since the owning file passes alone. The
hypothesis, not proved: the reachability modal arrives during the journey, and
`dismissStartupDialogs` (`electron-startup-dialogs.ts`) closes it through a
Playwright locator handler, which races whichever step is running when it opens.
The modal hides the window from role queries until it closes, which would explain
the zoom button timeout. It would also explain why the failing step varies.

Not checked: whether the failure rate differs on a host whose firewall lets
Docker reach the backend, where this modal does not open, or with a real display.

**Next step:** on a host where the modal opens, record when it opens and closes
against the journey's steps, then rerun on a host where it does not open.

## Recurrence during 7041 task 2 (2026-11-06)

Three runs alone on beelink at `main` `c1724ab74`, through
`mise run test:logged -- … bunx playwright test --config e2e/agent-testing/playwright.electron-headless.config.ts`
with `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`, one worker. Docker's
automatic address pools were exhausted.

| Run | Probe | Docker shim on PATH | Result |
| --- | --- | --- | --- |
| 1 | on | no (the probe network could not be created) | passed, 18.5 s |
| 2 | on | yes (probe network created on a /29, removed within 6 s) | failed: `toHaveTitle` timed out after 150 s on `Orkestrator AI` instead of `Orkestrator AI — DEV [design-canvas-electron]` (`design-canvas-electron-journey.ts:96`), then cleanup hit [1131](1131-design-electron-graceful-quit-deadline.md) |
| 3 | off | yes | failed in cleanup only: `Owned processes did not exit` ([1131](1131-design-electron-graceful-quit-deadline.md)) |

Run 3 failed with the probe off, so these runs do not show that the probe's
modal causes the failures. Run 2's title timeout is a new failing step. When the
probe ran, its modal may have opened, but that was not recorded. Whether Electron
specs should skip the probe was to-do 7470 task 1 (retired 2026-11-10).

## Probe off by default for Electron specs (2026-11-09)

To-do 7470 task 1 (retired 2026-11-10; see the
[testing guide](../../../development/testing-guide.md#cli-scenarios)) launches every Electron spec with `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`
(`electronSpecEnvironment`), so the boot check no longer runs and its modal no
longer opens during this journey. One headless run alone on beelink, branch
for 7470 based on `main` at `c6de4733c`, `playwright.electron-headless.config.ts`
with `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1` and the scoped Docker shim on
`PATH`: passed in 48 s. One pass does not resolve this case: run 3 above
failed with the probe off, so the modal is not shown to be the cause, and the
status stays open until repeated runs with the probe off pass.
