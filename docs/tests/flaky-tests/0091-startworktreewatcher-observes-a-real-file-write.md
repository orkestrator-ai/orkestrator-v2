# `startWorktreeWatcher > observes a real file write` (`tests/unit/backend/worktree-watcher.test.ts:237`)

- **ID:** 0091
- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Suite counts:** 3,686 passed, 1 skipped, 1 failed
- **Failure:** `expect(changes).toBeGreaterThan(0)` received `0` after one file write and a fixed 280 ms total wait; failed duration 281.50 ms
- **Isolated rerun:** `bun test tests/unit/backend/worktree-watcher.test.ts` -> 24 passed, 0 failed; the target passed in 284.11 ms
- **Root cause:** The test drives the real recursive `fs.watch` implementation. The first failure looked like aggregate scheduler contention, but a stress version that waited up to two seconds for one write still missed one event in 30 repetitions. A single OS watcher event is therefore not a reliable synchronization primitive for this test.
- **Fix:** The test now performs bounded, distinct file writes until the watcher reports a change or a two-second deadline expires. A broken watcher still fails at the deadline, while one dropped OS event no longer fails the suite.
- **Verification:** `bun test tests/unit/backend/worktree-watcher.test.ts --test-name-pattern "observes a real file write" --rerun-each 50` -> 50 passed, 0 failed. Targeted stress and the final aggregate suite both passed.
