# `standalone backend service > drains an active local server process tree before exiting` (`apps/backend/tests/standalone.test.ts`)

- **ID:** 0122
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test --cwd apps/backend src tests --parallel 2>&1 | tee /tmp/rev-backend-tests-cwd.log`, at or immediately after `c4ce823fb218e0f858115c0e0ada81203998c10a`
- **Worker configuration:** Backend package only, `bun test src tests --parallel`, run on its own rather than inside `bun run test`.
- **Failure:** timed out after 5,000 ms (reported duration 5,001.55 ms) with no assertion message.
- **Suite counts:** Backend package: 1,696 total, 1,695 passed, 1 failed across 55 files in 37.02 s.
- **Isolated rerun:** `bun test --cwd apps/backend ./tests/standalone.test.ts` -> 8 passed, 0 failed in 35.48 s. Evidence: `/tmp/rev-isolated-standalone.log`.
- **Related:** a different case in the same file, `exits without a leftover listener when environment-managed Serve setup fails`, is recorded separately above. Both cases boot a real backend process and wait on its shutdown.
- **Hypothesis:** The test spawns a real local server process tree and waits for the drain to complete. The isolated file takes 35.48 s for 8 tests, so this suite is already near the budget per case without contention; a parallel backend run adds process-startup competition on top. A later run of the same command at the same head passed this case and failed a different backend test instead, which is consistent with a shared-resource race rather than a defect in the drain itself. Establish whether the outstanding wait is on process exit or on port release before adjusting the budget.
