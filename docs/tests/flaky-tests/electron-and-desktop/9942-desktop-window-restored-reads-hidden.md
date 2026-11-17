# Desktop window polls: the restored window turned `hidden` again with no read (`e2e/agent-testing/window-visibility-polls-electron.spec.ts`)

- **ID:** 9942
- **Status:** open
- **Date observed:** 2026-11-15
- **Test:** `hidden, minimised and covered windows on a desktop pause their polls`
- **File:** `e2e/agent-testing/window-visibility-polls-electron.spec.ts:517` at
  `a8b89f154` (line 518 now)
- **Original command:** `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1 mise run test:logged -- --name t2181-mbp3-electron -- mise run test:agent:electron`,
  for to-do [2181](../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md) task 1 (pull request #2288), observing branch base `a8b89f154`. `ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1` is what lets this
  desktop case put its small windows on the Mac's display.
- **Worker configuration:** macOS 27.2 arm64 on `mbp3` (MacBook Pro, Apple M5 Max, 18 cores; the built-in display and two 6016x3384 external displays), Electron 45.2.3, Playwright 1.65.0, one worker, windows shown on the unlocked real display. The user's production Orkestrator was the front application and other builds kept the host heavily loaded (load averages 79 to 169 between runs).
- **Failure:** the `restored` step (restore the minimised window, expect
  `visible` and a poll read) reached `visible`, then read `hidden` with
  0 reads and no read within 3.4 s, so the step's read assertion failed. The
  earlier steps matched the passing runs (shown: `visible`, 3 reads;
  hidden and minimised: `hidden`, 0 reads, coordinator paused; shown again:
  first read after 650 ms); covered and uncovered behaved as expected
  afterwards. Suite counts: 37 passed, 38 skipped, 7 failed, 952.6 s, plus `Worker teardown timeout of 120000ms exceeded` after the seeded preview case.
- **Isolated rerun:** after rebasing onto `47110af03`, the case alone
  passed 4 of 4 (the first of them under `--repeat-each=3`), with first
  reads after 896 to 1207 ms when restored. Exact run IDs were not recorded.
- **Evidence:** the run's compressed failure log, `t2181-mbp3-electron.log.gz`, was kept in a temporary `orkestrator-test-run.*` directory on `mbp3` and was not re-read for this case; the observation is as recorded in 2181's Current state ("Real-display run on mbp3") and in to-do 8300 (retired).
- **Recurrence check:** no case in the register covers this spec.
- **Hypothesis (unconfirmed):** the restored window was occluded again on a
  desktop shared with the user's front application and other worktrees'
  Electron runs, so macOS reported it hidden; the product paused correctly
  for what it was told. Not established: the window's occlusion state was
  not captured at that moment.
