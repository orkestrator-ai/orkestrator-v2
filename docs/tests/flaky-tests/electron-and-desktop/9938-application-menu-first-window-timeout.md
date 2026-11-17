# Application menu case: the Electron window never appeared within 30 s (`e2e/agent-testing/application-menu-electron.spec.ts`)

- **ID:** 9938
- **Status:** open
- **Date observed:** 2026-11-15
- **Test:** `Help offers Open Developer Tools only while a renderer has debug logging on`
- **File:** `e2e/agent-testing/application-menu-electron.spec.ts:30` (line 30 at `a8b89f154` and now)
- **Original command:** `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1 mise run test:logged -- --name t2181-mbp3-electron -- mise run test:agent:electron`,
  for to-do [2181](../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md) task 1 (pull request #2288), observing branch base `a8b89f154`.
- **Worker configuration:** macOS 27.2 arm64 on `mbp3` (MacBook Pro, Apple M5 Max, 18 cores; the built-in display and two 6016x3384 external displays), Electron 45.2.3, Playwright 1.65.0, one worker, windows shown on the unlocked real display. The user's production Orkestrator was the front application and other builds kept the host heavily loaded (load averages 79 to 169 between runs).
- **Failure:** `electronApplication.firstWindow` timed out after 30 s: the
  fixture's Electron never reported its first window. Suite counts: 37 passed, 38 skipped, 7 failed, 952.6 s, plus `Worker teardown timeout of 120000ms exceeded` after the seeded preview case.
- **Isolated rerun:** after rebasing onto `47110af03`, the case alone
  (`application-menu-electron.spec.ts:30` through the same Electron config)
  passed. Its exact run ID was not recorded.
- **Evidence:** the run's compressed failure log, `t2181-mbp3-electron.log.gz`, was kept in a temporary `orkestrator-test-run.*` directory on `mbp3` and was not re-read for this case; the observation is as recorded in 2181's Current state ("Real-display run on mbp3") and in to-do 8300 (retired).
- **Recurrence check:** not a recurrence of an existing case. The same test
  has [9929](9929-windows-native-menu-devtools-app-closed.md) (open: Electron closing
  right after DevTools opened on Windows CI) and
  [9935](9935-linux-native-menu-devtools-open-poll.md) (resolved: DevTools not
  reported open on Linux CI); both are later in the case than a window that
  never appeared. `mise run flaky:recurrence -- 9935 --base a8b89f154 --registry-ref origin/main`
  answers "base predates fix 6302f96c69".
- **Hypothesis (unconfirmed):** host load. The window wait was 30 s, and
  Electron started under load averages above 79. Since this run,
  `6302f96c6` (#2306) gave this launch and its `firstWindow` a 60 s
  watchdog and the title wait 60 s; whether that is enough on a loaded
  shared Mac has not been observed, so the case stays open.
