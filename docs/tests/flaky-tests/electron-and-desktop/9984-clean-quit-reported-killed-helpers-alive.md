# A clean Electron quit reported as "killed" while its helpers were still leaving (`renderer-log-boundary-electron.spec.ts`)

- **ID:** 9984
- **Status:** resolved
- **Date observed:** 2026-11-16
- **Base:** `0d12d63ee7fc795fa29a028517950f624fa61fec` (main; earlier PR runs from 2026-11-16 on older bases
  show the same failure).
- **Test:** `a real window sends its startup markers to the main process and
  none of its logger lines` in
  `e2e/agent-testing/renderer-log-boundary-electron.spec.ts` (line 506).
- **Failure:** `Electron did not exit within 725 ms of the quit`:
  `closeElectronWithin` returned `"killed"` where `"closed"` was expected
  (another run: 524 ms).
- **Original command:** the "Native menu (ubuntu-latest)" GitHub workflow
  job, which runs the Electron specs with repeats under Xvfb (25 cases, one
  worker). PR runs 43955519573 (#2340) and 43863547803 (#2335) failed this
  one case once each (24 passed); the same case passed in its other repeats,
  and on macOS and Windows.

## Observations

- 2026-11-16: the failing run's `electron-diagnostics` attachment ends with
  `[backend] shutdown.finished code=0`, the expected
  `[desktop.dialog] quitting-cancelled source=uncaught-exception` and
  `[electron] exited (code 0, signal none)`: Electron quit cleanly and fast.

## Resolution (2026-11-16)

- **Root cause:** `closeElectronWithin`
  (`e2e/agent-testing/design-electron-cleanup.ts`) checked the Electron
  process tree it had snapshotted the instant `ElectronApplication.close()`
  resolved. `close()` resolves when the browser process exits; on Linux its
  helpers (zygote, GPU, utility, the child backend) leave a moment later, so
  one still alive at that instant was SIGKILLed and the clean quit was
  reported as `"killed"`.
- **Fix:** after a settled `close()`, `closeElectronWithin` waits up to
  2 s (`CLOSED_HELPER_EXIT_GRACE_MS`) for the owned tree to stop before
  deciding. A timed-out close is still killed at once, and a descendant that
  outlives the grace (an orphan) is still killed and reported.
- **Reproduced:** yes — the new unit test `a helper that leaves shortly after
  a settled close counts as closed, not killed`
  (`tests/unit/electron-spec-process-ownership.test.ts`) closes a fake whose
  helper outlives the root by about a second. Without the fix it fails with
  `Expected: "closed"`, `Received: "killed"`; with it, it passes. The real
  Electron run on Linux was not repeated here (macOS host).
- **Stress:** not run; the unit file passed alone
  (`bun test tests/unit/electron-spec-process-ownership.test.ts`).
