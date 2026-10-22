# Claude bridge plan-exit persistence under the aggregate suite

- **ID:** 0513
- **Status:** resolved
- **Date observed:** 2026-10-21
- **Test:** `plan approval flow > keeps plan mode enabled when an approved exit cannot be persisted`
- **File:** `bridges/claude-bridge/src/services/session-manager-interactions.test.ts:846`
- **Original command:** `mise run test:logged -- mise run test:changed` (command-node M3 run; the bridges group ran concurrently with the workspace group).
- **Worker configuration:** default `scripts/test-all.ts` planning on the development Mac; worker counts not captured.
- **Failure:** the test failed after 1.43 ms in the aggregate run, with session-manager prompt-settle errors logged around it.
- **Isolated rerun:** `bun test src/services/session-manager-interactions.test.ts` from `bridges/claude-bridge` passed three times in a row (29 pass, 0 fail).
- **Evidence:** `orkestrator-test-run.gQwlaB` under the host temporary directory.
- **Hypothesis:** ordering or timing between interaction cleanup and the failed-turn settle under host load. The change under test (command nodes) does not touch the bridges; `git diff main -- bridges` is empty. No implementation, assertion, timeout or skip changed.

## Federated client main merge — 2026-10-21

`mise run test:logged -- --name merge-full -- mise run test`, merging
`origin/main` into pre-merge HEAD `723e2d9e`, repeated the approved-exit case
at 1.44 ms with `EISDIR` opening the fixture's `.claude` directory. The
workspace/root/bridges/protocol groups reserved 4/1/2/1 slots; the Claude
package used one isolated Bun worker. Claude reported 1,600 passed, five
skipped and one failed across 76 files (39.85 seconds). Browser and Electron
validation were also running on the host.

`mise run test:logged -- --name merge-claude-owner -- bun test --cwd
bridges/claude-bridge --preload ../../tests/setup-node.ts
./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures`
passed the entire unchanged owner, exit 0 in 1.2 seconds. Evidence:
`orkestrator-test-run.0OlBGi/bridges.log.gz` below the host temporary directory.
This confirms an intermittent recurrence; the fixture ordering or contention
cause remains unconfirmed. No implementation, assertion, timeout or skip changed.

## Remote workspace refreshed main merge — 2026-10-21

- **Command:** `mise run test:logged -- --name refresh-tests -- mise run test`, merging main `f228a6aa9` into pre-merge HEAD `aade0bcd5`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; one isolated Claude worker, alongside component and isolated-stack browser validation.
- **Failure:** the same fixture write failed with `EISDIR` at line 863 (3.64 ms). Claude reported 1600 passed, five skipped and one failed across 76 files (60.19 seconds); the other bridge packages passed.
- **Owning-file rerun:** `mise run test:logged -- --name refresh-claude-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 0.2 seconds logged).
- **Evidence:** `orkestrator-test-run.Qv1f63/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence. No bridge implementation, assertion, timeout or skip changed.

## Resolution — 2026-10-22

- **Status:** resolved. Same cause and fix for 0385, 0473 and 0513.
- **Root cause:** `writeTurnInFlightMark` (`session-manager-turn-interruption.ts`)
  records the turn-in-flight mark with an un-awaited `updateSessionPreferences`
  call when a prompt starts. The preference write resolves the Claude home when
  it runs (`withPreferenceFileLock` calls `claudeSessionPreferencesDir()`), not
  when it was queued. The fixtures switch to a fresh temporary home and replace
  `.claude` with a file within about a millisecond of the prompt starting, so the
  write's `mkdir -p .claude/orkestrator/session-preferences` could land first and
  the fixture's `writeFile` hit `EISDIR`. Instrumenting the fixture showed the
  racing directory held only `orkestrator/` (a recursive mkdir in flight), with
  the stack in `updateSessionPreferences`. In 0473 the home is switched after the
  prompt starts, which is why a rerun with the matching preload could also fail.
- **Fix:** `fix(ci): stop the Linux watcher crash and two fixture races keeping
  main red`. `blockClaudeConfigDir` in `session-manager-test-harness.ts` removes
  whatever `.claude` exists and writes the blocking file with `wx`, retrying
  (bounded) only when a concurrent mkdir won; once the file is in place no writer
  can create the directory, which is the state under test. All nine fixtures that
  replace `.claude` after setup use it; the assertions are unchanged. A version
  that waited for every queued preference write instead hung when a previous
  test left a write parked under controlled time, so it was not used.
- **Verification:** before the fix,
  `bun test --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts ./src/services/session-manager-system-events.test.ts --rerun-each 30`
  (from `bridges/claude-bridge`, macOS arm64, Bun 1.4.3) failed 10, 8 and 11
  times in three runs of 2,130 cases, all EISDIR. After: 0 failures in three runs
  (2,130 passed each). The Claude bridge package (`bun run test:bridge`) passed.
  CI also hit this on `main` runs 39690434421 and 39701903157.
