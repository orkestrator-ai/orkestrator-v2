# Terminal revocation assertions race server socket disposal

- **ID:** 6064
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Tests:** `gateway terminal WebSocket > refuses queued input and resize after real browser session revocation` and `gateway terminal WebSocket > refuses queued input and resize after real client grant expiry`
- **File:** `apps/backend/tests/gateway-events.test.ts`

## Evidence

Preparation ran `mise run test:logged -- --name review-default-tests -- mise run test`
with the repository aggregate worker configuration. These two cases failed after
48.51 ms and 27.14 ms. The operation gauges were zero, but terminal socket and
channel gauges were still 1. Captured output is in
`.orkestrator/review-artifacts/review-validation-49fb6f3d-d2b6-4c30-923b-883b62914759/validation-04.stderr.txt`.

## Fix

The client close event can arrive before the server's close callback. Draining
queued operations does not synchronize server transport disposal. The test now
waits for the server socket count to reach zero before asserting the complete
zero-gauge snapshot. It still requires queued input and resize to be refused;
no assertion or timeout was removed or relaxed.

`mise run test:logged -- --name fixes-backend-owner -- bash -c 'cd apps/backend && NODE_ENV=test bun test ./src/core/commands-registry-coordinator-nodes.test.ts ./tests/gateway-events.test.ts --parallel=2 --only-failures'`
passed in 3.5 seconds after the fix. The aggregate rerun is recorded in the
Address Findings result.
