# Pi session list timeout before SDK read

- **ID:** 5183
- **Status:** resolved
- **Observed:** 2026-11-05
- **Test:** `the resumable session list > a timeout is reported, not an empty history, and stops the read`
- **File:** `bridges/pi-bridge/src/session-list-cache.test.ts`

Preparation at `1f29ea09f` ran `mise run test:logged -- --name review-default-tests -- mise run test` (runner-controlled workers). The test failed in 24.58 ms: expected `signal?.aborted` true, received undefined. Pi group: 615 pass, 1 skip, 1 fail across 41 files. Evidence: `.orkestrator/review-artifacts/review-validation-dfec1989-9a95-4252-bf87-b8311d625a17/validation-04.stderr.txt`, lines 2870–2890. The aggregate also reported the index-count failure; the workspace-group nonzero exit is not attributable from this excerpt.

The unchanged owner passed alone on 2026-11-05:

```sh
mise run test:logged -- --name pi-list-rerun -- bun test ./bridges/pi-bridge/src/session-list-cache.test.ts --preload ./bridges/pi-bridge/src/testing/test-isolation.ts --parallel=1 --only-failures
```

Result: pass in 2.7 s (623 output bytes; passing output removed by runner).
The test gives the whole read 5 ms, including the asynchronous file-stamp read before `SessionManager.list`. Under load that can expire before the mock receives the signal. This is a timing hypothesis supported by the missing signal, not a proven root cause. No production or test behavior was changed. Triage marks it related via shared storage logging vocabulary; the branch changes no Pi bridge files.

## Root cause and fix (resolved 2026-11-05)

The hypothesis held, and it exposed a production defect as well as a timing
assumption in the test. `readResumableSessions` awaits `sessionFilesStamp`
(a `readdir` plus one `stat` per file) before it calls `SessionManager.list`.
When the 5 ms ceiling expired during that await, `listResumableSessions`
rejected with `TimeoutError` before the mock had been handed a signal, so the
test read `undefined`. The abandoned read then carried on and started a full
`SessionManager.list` parse that nobody was waiting for.

- **Fix in `bridges/pi-bridge/src/agent-session.ts`:** `readResumableSessions`
  calls `signal.throwIfAborted()` after the stamp and cache check, so a read the
  ceiling gave up on never starts the parse. `sessionListReadSettledForTests()`
  lets tests wait for an abandoned read to stop.
- **Fix in the test:** both orderings are now driven by fake timers instead of
  wall-clock time. The original case advances the clock only after the list
  has started, then checks its signal was aborted. The new case
  `a timeout before the list starts never starts it` advances the clock at
  once, waits for the abandoned read to settle and checks `SessionManager.list`
  was never called, then that a later read still lists the session.
- **Proof:** with the `throwIfAborted` line removed, the new case fails
  (`mise run test:logged -- --name pi-list-neg -- bun test ./bridges/pi-bridge/src/session-list-cache.test.ts --preload ./bridges/pi-bridge/src/testing/test-isolation.ts --parallel=1`).
  With it, the owner passed five consecutive runs and the whole Pi bridge
  suite passed with four workers
  (`ORKESTRATOR_TEST_WORKERS=4 mise run test:logged -- --name pi-bridge-suite -- bun run --cwd bridges/pi-bridge test:bridge`).
