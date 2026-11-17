# Service preview reattach case: the Electron context closed mid-case (`e2e/agent-testing/service-preview-electron.spec.ts`)

- **ID:** 9940
- **Status:** open
- **Date observed:** 2026-11-15
- **Test:** `history, app zoom, DevTools, screenshots and capture work after reattach`
- **File:** `e2e/agent-testing/service-preview-electron.spec.ts:944` at
  `a8b89f154` (line 926 now)
- **Original command:** `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 ORKESTRATOR_AGENT_TEST_SHOWN_WINDOWS=1 mise run test:logged -- --name t2181-mbp3-electron -- mise run test:agent:electron`,
  for to-do [2181](../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md) task 1 (pull request #2288), observing branch base `a8b89f154`.
- **Worker configuration:** macOS 27.2 arm64 on `mbp3` (MacBook Pro, Apple M5 Max, 18 cores; the built-in display and two 6016x3384 external displays), Electron 45.2.3, Playwright 1.65.0, one worker, windows shown on the unlocked real display. The user's production Orkestrator was the front application and other builds kept the host heavily loaded (load averages 79 to 169 between runs).
- **Failure:** `electronApplication.evaluate: Target page, context or browser has been closed`.
  The file is serial, so its later cases did not run. Which evaluate, and
  why Electron's context closed, was not established. Suite counts: 37 passed, 38 skipped, 7 failed, 952.6 s, plus `Worker teardown timeout of 120000ms exceeded` after the seeded preview case.
- **Isolated rerun:** after rebasing onto `47110af03`, the whole owning
  file passed this case (22 passed, 1 skipped, 1 failed; the failure was the
  remote terminal link case, [9941](9941-remote-terminal-link-failed-to-fetch.md)).
  The case cannot run alone by line: it needs the file's earlier serial
  cases.
- **Evidence:** the run's compressed failure log, `t2181-mbp3-electron.log.gz`, was kept in a temporary `orkestrator-test-run.*` directory on `mbp3` and was not re-read for this case; the observation is as recorded in 2181's Current state ("Real-display run on mbp3") and in to-do 8300 (retired).
- **Recurrence check:** no case in this group covers this test.
- **Hypothesis:** none established. The same suite run lost Electron
  windows in other files under the same load: the application menu case
  ([9938](../electron-and-desktop/9938-application-menu-first-window-timeout.md))
  and the seeded preview case ([9902](9902-seeded-preview-adjacent-port-reservation.md)) both timed out waiting for their
  first window.
