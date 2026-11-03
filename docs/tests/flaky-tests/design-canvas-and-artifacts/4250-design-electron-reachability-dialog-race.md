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
