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


## OpenCode review-fix validation recurrence — 2026-10-26

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` at `2015359f9`; standard 4/1/2/1 group reservations and two isolated backend workers.
- **Failure:** the same test received zero changes after the bounded distinct-write loop (2,006.05 ms), so the prior fix does not eliminate the aggregate failure. Reopened this record.
- **Suite counts:** backend 11,228 passed, 95 skipped, four failed and one error across 657 files (488.13 seconds); full details and evidence are in [0978](../aggregate-validation-runs/0978-opencode-undo-validation-backend-timeouts.md).
- **Unchanged owner rerun:** `mise run test:logged -- --name worktree-watcher-owner-rerun -- bun test --cwd apps/backend ./tests/worktree-watcher.test.ts --parallel=1 --only-failures` passed, exit 0 in 1.4 seconds.
- **Assessment:** aggregate-only recurrence; host contention or delayed OS watcher delivery remain hypotheses. No watcher code, assertion, deadline or skip changed.
