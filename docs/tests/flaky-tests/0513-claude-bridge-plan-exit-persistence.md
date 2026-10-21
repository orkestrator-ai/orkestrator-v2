# Claude bridge plan-exit persistence under the aggregate suite

- **ID:** 0513
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `plan approval flow > keeps plan mode enabled when an approved exit cannot be persisted`
- **File:** `bridges/claude-bridge/src/services/session-manager-interactions.test.ts:846`
- **Original command:** `mise run test:logged -- mise run test:changed` (command-node M3 run; the bridges group ran concurrently with the workspace group).
- **Worker configuration:** default `scripts/test-all.ts` planning on the development Mac; worker counts not captured.
- **Failure:** the test failed after 1.43 ms in the aggregate run, with session-manager prompt-settle errors logged around it.
- **Isolated rerun:** `bun test src/services/session-manager-interactions.test.ts` from `bridges/claude-bridge` passed three times in a row (29 pass, 0 fail).
- **Evidence:** `orkestrator-test-run.gQwlaB` under the host temporary directory.
- **Hypothesis:** ordering or timing between interaction cleanup and the failed-turn settle under host load. The change under test (command nodes) does not touch the bridges; `git diff main -- bridges` is empty. No implementation, assertion, timeout or skip changed.
