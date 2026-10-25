# Electron first-window startup timeout

- **ID:** 0157
- **Status:** open
- **Date observed:** 2026-09-22
- **Test:** `real Electron main process shares one backend across independent windows`
  in `e2e/agent-testing/electron-main.spec.ts`.
- **Original command:** `mise run test:logged -- --name startup-electron -- mise run test:agent:electron`
- **Worker configuration:** Playwright, one worker; `mise run test` was also running.
- **Failure:** `electronApplication.firstWindow: Timeout 30000ms exceeded while
  waiting for event "window"` at line 174. The command finished in 43.4 seconds.
- **Suite counts:** Two tests: one failed, one platform-specific test skipped.
- **Isolated rerun:** The same command (whose configuration selects only this
  owning file) passed in 7.7 seconds: one passed, one platform-specific test
  skipped. The repository workspace group was still finishing, but the root
  and bridge groups had completed. No Electron test assertions or timeouts changed.
- **Hypothesis:** The failure preceded the first renderer window, so the new
  renderer readiness gate was not reached. Concurrent compilation/startup load
  is a possibility, not an established cause. The test launches the emitted
  desktop files, and both the Electron suite and repository build write those
  files. The failing trace does not record enough main-process startup evidence
  to identify the cause. Do not treat the rerun as proof that the user's
  first-launch-after-repackaging issue has been reproduced or resolved.

The failure log was retained at
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.ZPh8DK/startup-electron.log.gz`.
The Playwright trace was under
`output/agent-testing/electron-smoke/electron/artifacts/`; the successful rerun
replaces that run-id's artifacts.

## A confirmed cause with the same symptom (2026-10-17)

On macOS 27.0 (arm64, Electron 44.7.0, `main` at `31d0fb06`), `mise run
test:agent:electron` failed this test and `remote nicknames refresh all native
titles and Window menu entries` with `electronApplication.firstWindow`
timeouts, and the first `web-annotations-electron.spec.ts` test the same way.
This test failed again alone. The backend started and listened, but no window
appeared.

The cause was the login Keychain. The specs' fixed profile names give fixed
`safeStorage` items (`Orkestrator AI — DEV [electron-smoke] Safe Storage`,
created 2026-10-01 by an earlier Electron build). The current binary is not on
the item's access list, so `ConnectionManager.initialize()` awaited
`safeStorage.isAsyncEncryptionAvailable()` behind an access prompt nobody
answered. A standalone Electron probe with that app name stayed pending for
20 s; with `[electron-resume]` (an item created 2026-10-15) or a fresh name it
returned in milliseconds; with `use-mock-keychain` it returned in 4 ms and
round-tripped encryption without touching the Keychain.

Agent-test profiles on macOS now append `use-mock-keychain`
(`chromiumSwitchesForRuntime` in `apps/desktop/electron/runtime-profile.ts`).
After that, `firstWindow` succeeded in every launch: the whole Electron suite
(10 passed, 1 skipped) and five further runs of this test. This test still
fails later, at native focus, on this shared host; see
[0271](0271-electron-native-focus-shared-macos-desktop.md).

The 2026-09-22 observation passed on rerun, which an unanswered Keychain
prompt would not do, so its cause stays unconfirmed and this case stays open.

## Startup title recurrence (2026-10-17)

During annotation review validation, the same independent-windows case failed
its initial `toHaveTitle(profile.electronTitle)` after five seconds (received
`Orkestrator AI`) while repository validation and a second Electron spec were
running. Command: `mise run test:logged -- --name windows-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts electron-main.spec.ts`.
The owning file reported 2 passed, 1 failed and 1 platform skip (39.2 seconds).
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.z3sGAe/windows-electron.log.gz`.

The final sequential `test:agent:electron` run passed all three applicable cases
in this file (whole suite: 14 passed, 1 skipped in 80.4 seconds). The startup
title assertion and timeout were unchanged. The separate Window-menu
non-key-window fallback was fixed between runs; it cannot explain an earlier
startup-title timeout. Concurrent startup/build contention remains a hypothesis.

## Service preview rollout (0042) — 2026-10-25

In the first owner rerun of `electron-main.spec.ts` after a loaded full suite
(`ORKESTRATOR_AGENT_TEST_RUN_ID=svc0042-owner-electron-main`, load 43 to 60),
`real Electron main process shares one backend across independent windows`
(line 571) timed out in `electronApplication.firstWindow` after 30 s. The
mock keychain was in use, so the 2026-10-17 Keychain cause does not apply.
The next owner rerun (`svc0042-owner2-electron-main`) passed the unchanged
file (3 passed, 1 skipped, 40.4 s), as did the second full suite
(`svc0042-suite-2`, 38 passed). No assertion, timeout or skip changed.
