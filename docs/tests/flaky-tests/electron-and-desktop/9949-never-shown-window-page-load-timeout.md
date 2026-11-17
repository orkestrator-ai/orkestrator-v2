# Never-shown window polls: the fixture page did not load within 90 s (`e2e/agent-testing/window-visibility-polls-electron.spec.ts`)

- **ID:** 9949
- **Status:** open
- **Date observed:** 2026-11-15
- **Test:** `a hidden window's polls read only while Electron reports it visible`
- **File:** `e2e/agent-testing/window-visibility-polls-electron.spec.ts:456` at
  `a8b89f154` and `47110af03` (line 457 now)
- **Original command:** it passed in the full suite
  `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1 mise run test:logged -- --name t2181-mbp3-electron -- mise run test:agent:electron`
  (for to-do [2181](../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md) task 1 (pull request #2288), observing branch base `a8b89f154`). It failed only in reruns of the case alone after rebasing onto
  `47110af03` (base `47110af03`), one worker, at load averages near 145.
- **Worker configuration:** macOS 27.2 arm64 on `mbp3` (MacBook Pro, Apple M5 Max, 18 cores; the built-in display and two 6016x3384 external displays), Electron 45.2.3, Playwright 1.65.0, one worker, windows shown on the unlocked real display. The user's production Orkestrator was the front application and other builds kept the host heavily loaded (load averages 79 to 169 between runs).
- **Failure:** the case reached its 90 s test timeout before the fixture's
  page in a never-shown window had finished loading, in 2 of the solo runs
  (8300 counted 2 of 5; 2181's Current state counts 4 of 6 passing). The
  failure message then held only Chromium's teardown lines; 2181's change
  since makes the fixture's exit-code assertion print its step lines, so a
  later hang names the step it stopped at.
- **Isolated rerun:** the other solo runs passed (`hidden` and 0 reads;
  `visible` with throttling off, first read after 587 ms, 6 reads;
  `hidden` and 0 reads again).
- **Evidence:** the run's compressed failure log, `t2181-mbp3-electron.log.gz`, was kept in a temporary `orkestrator-test-run.*` directory on `mbp3` and was not re-read for this case; the observation is as recorded in 2181's Current state ("Real-display run on mbp3") and in to-do 8300 (retired).
- **Recurrence check:** no case in the register covers this spec.
- **Hypothesis (unconfirmed):** host load. A page load in a never-shown,
  background-throttled window took longer than the case's 90 s budget at
  load averages near 145 on 18 cores; the step lines that would confirm where
  it stopped did not exist yet.
