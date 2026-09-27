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
