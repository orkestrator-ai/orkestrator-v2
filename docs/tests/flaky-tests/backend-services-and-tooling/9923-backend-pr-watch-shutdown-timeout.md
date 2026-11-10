# Backend PR-watch shutdown test times out during merge validation

- **ID:** 9923
- **Status:** open
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
