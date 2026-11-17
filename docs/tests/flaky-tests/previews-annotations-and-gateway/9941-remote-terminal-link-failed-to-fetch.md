# Remote terminal link case: `Failed to fetch` from the second window's transport (`e2e/agent-testing/service-preview-electron.spec.ts`)

- **ID:** 9941
- **Status:** open
- **Date observed:** 2026-11-15
- **Test:** `a remote terminal link opens the native localhost forward in a separate browser`
- **File:** `e2e/agent-testing/service-preview-electron.spec.ts:3140` at
  `a8b89f154` (line 2986 now)
- **Original command:** in the full suite
  `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1 mise run test:logged -- --name t2181-mbp3-electron -- mise run test:agent:electron`
  (for to-do [2181](../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md) task 1 (pull request #2288), observing branch base `a8b89f154`) the case did not run: the file is serial and
  [9940](9940-service-preview-reattach-context-closed.md) failed before it.
  It failed in the rerun of the whole owning file after rebasing onto
  `47110af03` (base `47110af03`), one worker: 22 passed, 1 skipped, 1 failed.
- **Worker configuration:** macOS 27.2 arm64 on `mbp3` (MacBook Pro, Apple M5 Max, 18 cores; the built-in display and two 6016x3384 external displays), Electron 45.2.3, Playwright 1.65.0, one worker, windows shown on the unlocked real display. The user's production Orkestrator was the front application and other builds kept the host heavily loaded (load averages 79 to 169 between runs).
- **Failure:** `page.evaluate: TypeError: Failed to fetch` from
  `invokeImmediately` in `apps/web/src/lib/native/node-transport.ts`,
  inside one of the second window's `page.evaluate` calls.
- **Isolated rerun:** none passed on `mbp3`. It does not meet the register's
  "passes alone" rule: on the same Mac the 7062 run (base `0cc406750`)
  failed it the same way in the full suite and again alone by `-g`
  ([8301](../../todo/cross-cutting/8301-electron-specs-failing-on-a-macos-display.md)
  task 2). It is recorded here because to-do 8300 (retired) asked for a case
  for the 2181 run's failure; finding its cause is 8301 task 2.
- **Evidence:** the run's compressed failure log, `t2181-mbp3-electron.log.gz`, was kept in a temporary `orkestrator-test-run.*` directory on `mbp3` and was not re-read for this case; the observation is as recorded in 2181's Current state ("Real-display run on mbp3") and in to-do 8300 (retired).
- **Recurrence check:** `mise run flaky:recurrence -- 2390 --base 47110af03 --registry-ref origin/main`
  answers that the base contains 2390's fix. It is not counted as a
  recurrence of [2390](2390-remote-terminal-link-hover-new-window.md): that
  case was a lost link hover behind a startup dialog, not a failed fetch.
- **Hypothesis:** none established. Which invoke failed, and whether the
  second backend was listening at that moment, was not recorded.
