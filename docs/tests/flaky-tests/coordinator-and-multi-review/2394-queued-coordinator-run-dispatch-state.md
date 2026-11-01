# Queued Coordinator run reports accepted instead of not-sent when closed under load

- **ID:** 2394
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `Coordinator conversations are public sessions > a queued run is interrupted and retired by the real close path`
- **File:** `apps/backend/src/core/public-api/public-api-coordinator-sessions.test.ts`
- **Original command:** `mise run test` on branch `shared-logger-foundation-and-electron-r1-slice-1-2a438948d729` based on `066fcb497`, host load averages about 29 to 38. Backend: 12,967 passed, 1 failed.
- **Failure:** `toMatchObject` expected `dispatch.state` `not-sent` and received `accepted`, in an operation otherwise as expected: `state` and `execution.state` `interrupted`, error `run-interrupted`, `result.queued` true. Duration 1,108.92 ms.
- **Isolated rerun:** `mise run test:logged -- --name alone-public-api-coordinator-sessions -- bun --cwd=apps/backend test ./src/core/public-api/public-api-coordinator-sessions.test.ts --parallel=2 --only-failures` passed (2.0 s).
- **Hypothesis:** not established. The received state suggests the queued run began dispatching before the close reached it. That is an inference from one result; the race was not reproduced. The branch only adds a logger configuration call to the backend's `main.ts`, which this test does not run.
