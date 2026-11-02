# Coordinator conversations are public sessions > a queued run is interrupted and retired by the real close path

- **ID:** 2414
- **Status:** open
- **Test:** `Coordinator conversations are public sessions > a queued run is interrupted and retired by the real close path`
- **File:** `apps/backend/src/core/public-api/public-api-coordinator-sessions.test.ts`

On 2026-11-02, during the shared-logger backend migration, this failed once in `mise run test` (the run before it passed 13,115 backend tests with 0 failures). The record read back held `dispatch.state: accepted` where the test expects `not-sent`, so the queued run was dispatched before the close reached it. The owner passes alone. Hypothesis, not proven: under load the dispatch wins the race with the close.

```sh
cd apps/backend && bun test --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-coordinator-sessions.test.ts --only-failures
```
