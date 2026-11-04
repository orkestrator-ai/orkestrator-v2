# Parent-bound wrapper termination timeout

- **ID:** 4471
- **Status:** open
- **Date observed:** 2026-11-04
- **Test/file:** `spawnParentBoundCommand > stops the command when the wrapper is terminated`, apps/backend/tests/shell.test.ts:382
- **Original command:** the `Tests (backend)` shard of the CI workflow on PR #1731 (run 41771907369, job 126383322172, commit e15962b84), through `@orkestrator/backend:test:workspace`.
- **Failure:** `this test timed out after 5000ms`, recorded at 5,000.14 ms. It happened once.
- **Suite counts:** the backend shard reported 17,238 passed and 3 failed in 17,487 tests across 1,126 files (838.85 s).
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./tests/shell.test.ts` from `apps/backend`: 24 passed, 0 failed, exit 0.
- **Load rerun:** the single test by name (`-t "stops the command when the wrapper is terminated"`), 24 runs with 8 at a time: 24 of 24 passed.
- **Hypothesis / fix:** none proven; the stalled operation is unknown. `apps/backend/src/core/shell.ts` and the test file are unchanged by PR #1731. No assertion, deadline or skip was changed.
