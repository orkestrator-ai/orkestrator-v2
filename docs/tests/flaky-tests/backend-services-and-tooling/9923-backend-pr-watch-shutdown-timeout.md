# Backend PR-watch shutdown test times out during merge validation

- **ID:** 9923
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Test:** `shutdown clears backend-owned PR watch state before a new backend starts`
- **File:** `apps/backend/src/core/index.test.ts`
- **Base commit:** `04639b12b71d4326a3b8941485367aca197f4966`
- **Merge parents:** `607e853d3c14d90f35b9712b0bcadba7c4aa87bc` and `1d7fadca9372393607e175fdf52da9d330bb67c1`.
- **Original command:** `mise run test:logged -- --name merge-focused -- bun test --cwd apps/backend ./src/core/index.test.ts --parallel=1 --only-failures` (one worker; default aggregate validation started while this focused run was active).
- **Failure:** test timed out after 5000 ms (5000.99 ms); 34 passed, 1 failed, 155 assertions, 21.51 s total.
- **Evidence:** `/tmp/orkestrator-test-run.DSrvNM/merge-focused.log.gz` (local, temporary).
- **Isolated rerun:** `mise run test:logged -- --name merge-focused-rerun -- bun test --cwd apps/backend ./src/core/index.test.ts --parallel=1 --only-failures` passed unchanged: 35 tests, 19.3 s. The default aggregate was still running.
- **Investigation:** root cause unconfirmed. This case initializes two real backends and creates PR-watch state within the default five-second test budget. Concurrent validation may contribute; no timing instrumentation establishes which operation exceeded the budget. The merge resolution touches only a timer comment and assertion in other tests. No timeout or assertion was changed.

## Resolution (2026-11-15)

- **Root cause:** the five-second default test budget. The case initializes two real backends in sequence and awaits each step's own completion (`init`, `invoke`, `shutdown`); it has no deadline, poll or sleep of its own, and `index.test.ts` sets no file-level budget (its `waitForCondition`/`resolvesWithin` helpers are not used by this case).
- **Fix:** `tests/default-test-timeout.ts` (preloaded by `tests/setup-node.ts`) makes the default budget a 60 s hang watchdog. No test change.
- **Reproduced:** no — not reproduced; the 5000.99 ms failure is the default-budget shape.
- **Stress:** none for this case.
