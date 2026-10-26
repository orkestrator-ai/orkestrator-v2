# `startWorktreeWatcher > observes a real file write` (`apps/backend/tests/worktree-watcher.test.ts:237`)

- **ID:** 0091
- **Status:** open
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Suite counts:** 3,686 passed, 1 skipped, 1 failed
- **Failure:** `expect(changes).toBeGreaterThan(0)` received `0` after one file write and a fixed 280 ms total wait; failed duration 281.50 ms
- **Isolated rerun:** `bun test apps/backend/tests/worktree-watcher.test.ts` -> 24 passed, 0 failed; the target passed in 284.11 ms
- **Root cause:** The test drives the real recursive `fs.watch` implementation. The first failure looked like aggregate scheduler contention, but a stress version that waited up to two seconds for one write still missed one event in 30 repetitions. A single OS watcher event is therefore not a reliable synchronization primitive for this test.
- **Fix:** The test now performs bounded, distinct file writes until the watcher reports a change or a two-second deadline expires. A broken watcher still fails at the deadline, while one dropped OS event no longer fails the suite.
- **Verification:** `bun test apps/backend/tests/worktree-watcher.test.ts --test-name-pattern "observes a real file write" --rerun-each 50` -> 50 passed, 0 failed. Targeted stress and the final aggregate suite both passed.


## Mobile settings review-fix validation — 2026-10-26

The review-fix `mise run test` on branch
`todo-0035-mobile-layout-gaps-49509c5f9933` used workspace/root/bridges/protocol
allocations of 4/1/2/1, with two backend workers. Backend finished with 11762
passed, 97 skipped and four failed across 703 files (636.58 s); the aggregate
finished in 654.9 s. Web passed 9834 tests. Aggregate evidence is
`orkestrator-test-run.x766cu/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory. The change touches no backend implementation
or backend tests.

The bounded repeated-write case at line 290 again observed zero changes
(2007.85 ms), despite the earlier fix. The complete unchanged owning file
also failed alone:

`mise run test:logged -- --name backend-watcher-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/worktree-watcher.test.ts --parallel=1 --only-failures`

Result: 33 passed, one failed (2008.82 ms), 34 tests total, 2.7 s logged.
Evidence: `orkestrator-test-run.lweF1u`. Reopened for this host recurrence;
it remains non-green in isolation, so load alone is not an established cause.
No watcher implementation, assertion, deadline or skip changed.
