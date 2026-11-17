# Renderer log boundary: a closing window read after it was destroyed (`e2e/agent-testing/renderer-log-boundary-electron.spec.ts`)

- **ID:** 9939
- **Status:** resolved
- **Date observed:** 2026-11-15
- **Test:** `a real window sends its startup markers to the main process and none of its logger lines`
- **File:** `e2e/agent-testing/renderer-log-boundary-electron.spec.ts:204` at
  `a8b89f154` (line 212 now); the failing call was at line 319.
- **Original command:** `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1 mise run test:logged -- --name t2181-mbp3-electron -- mise run test:agent:electron`,
  for to-do [2181](../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md) task 1 (pull request #2288), observing branch base `a8b89f154`.
- **Worker configuration:** macOS 27.2 arm64 on `mbp3` (MacBook Pro, Apple M5 Max, 18 cores; the built-in display and two 6016x3384 external displays), Electron 45.2.3, Playwright 1.65.0, one worker, windows shown on the unlocked real display. The user's production Orkestrator was the front application and other builds kept the host heavily loaded (load averages 79 to 169 between runs).
- **Failure:** `electronApplication.evaluate: TypeError: Object has been destroyed`
  at line 319: the evaluate that finds the window whose DevTools are open, to
  capture the inspector. Suite counts: 37 passed, 38 skipped, 7 failed, 952.6 s, plus `Worker teardown timeout of 120000ms exceeded` after the seeded preview case.
- **Isolated rerun:** after rebasing onto `47110af03`, the case alone
  passed. Its exact run ID was not recorded.
- **Evidence:** the run's compressed failure log, `t2181-mbp3-electron.log.gz`, was kept in a temporary `orkestrator-test-run.*` directory on `mbp3` and was not re-read for this case; the observation is as recorded in 2181's Current state ("Real-display run on mbp3") and in to-do 8300 (retired).
- **Recurrence check:** not a recurrence of
  [9984](9984-clean-quit-reported-killed-helpers-alive.md) (same test,
  resolved: a clean quit reported as killed). `mise run flaky:recurrence -- 9984 --base a8b89f154 --registry-ref origin/main`
  answers "base predates fix bf46e4c559", and the symptom differs.

## Resolution (2026-11-17)

- **Root cause:** just before line 319 the case opens an extra window, clicks
  **Help > Open Developer Tools** from it and calls `extra.close()`, which
  is asynchronous. A closing window can still be listed by
  `BrowserWindow.getAllWindows()` once it is destroyed, and reading its
  `webContents` then throws `Object has been destroyed`. Under load the
  destruction lands while the lookup iterates.
- **Fix:** `22e845e8f` (#2299, merged 2026-11-15, after this run's base)
  skips destroyed windows (`!win.isDestroyed()`) in both the DevTools poll
  and the inspector lookup, with a comment naming this error. This change
  only records the case against that fix.
- **Reproduced:** no. The fix landed in other work before this case was
  filed, and the failure was seen once, under load, on a base without it.
- **Stress:** none recorded for this case.
