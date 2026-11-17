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
  helper outlives the root. Without the fix it fails with
  `Expected: "closed"`, `Received: "killed"`; with it, it passes. The real
  Electron run on Linux was not repeated here (macOS host).
- **Stress:** not run; the unit file passed alone
  (`bun test tests/unit/electron-spec-process-ownership.test.ts`).

## Review repair and qualification (2026-11-17)

The original fixture's `sleep 1` began before process enumeration and close,
so scheduling could spend the helper's lifetime before the assertion. The
helper now waits on an explicit release file. The fake close observes the
root's exit and the helper still alive, then releases the helper to exit
naturally after 100 ms. The test deliberately waits 1,200 ms after readiness
before invoking close, longer than the original helper's entire lifetime.
The intermediate liveness assertion and final `closed` assertion are retained.

- **Focused:** `mise run test:logged -- --name fix-helper-ownership -- bun test ./tests/unit/electron-spec-process-ownership.test.ts --parallel=1 --only-failures`
  passed (12.8 s).
- **CPU contention:** five repetitions of the whole owner, with four owned
  Python busy-loop processes running throughout, passed: 65 tests, 250
  assertions, zero failures or skips (62.8 s). Each load process was stopped
  through its recorded process handle in `finally`.
  Command: `mise run test:logged -- --name fix-helper-cpu-load -- python3 output/agent-testing/address-review/helper-cpu-load.py`.
  The ignored wrapper runs `bun test ./tests/unit/electron-spec-process-ownership.test.ts --parallel=1 --rerun-each=5 --reporter=junit --reporter-outfile=output/agent-testing/address-review/helper-load.xml`.
- **Real Linux/Xvfb evidence:** the already-completed
  [Native menu run 43971417069](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/43971417069/job/133664246277)
  tested branch commit `ca513ae7fdf63372899721a296d4fb1ecb176da5`, including
  the two-second helper grace, with five repeats and no retries. Its
  [artifact 14279815596](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/43971417069/artifacts/14279815596)
  reports four complete passes of the renderer-log case (22.839, 22.452,
  22.134 and 21.767 s), each including the clean-close and code-zero checks.
  The remaining repeat failed earlier in the DevTools check with `Object
  has been destroyed`, before shutdown. The job overall had 23 passes and
  two failures; this evidence qualifies the clean-quit path, not the whole
  job. No additional Linux execution was launched from this macOS host.

Evidence is saved locally under `output/agent-testing/address-review/`:
`helper-load.xml`, `linux-native-menu-43971417069.zip` and
`linux-quit-evidence.json`. Original review-validation artifacts are unchanged.
