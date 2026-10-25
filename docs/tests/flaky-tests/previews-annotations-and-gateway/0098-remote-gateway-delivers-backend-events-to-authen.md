# `remote gateway > delivers backend events to authenticated event streams` (`tests/unit/electron/gateway.test.ts`)

- **ID:** 0098
- **Status:** resolved
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`); reproduced while isolating that group with `bun test tests --parallel=4`
- **Worker configuration:** Four Bun workers in the root group; the original run also executed workspace, bridge, protocol-lockfile, and iOS groups, and the confirming root-group run overlapped independent bridge and protocol/iOS isolation commands
- **Failure:** The test exceeded Bun's 5,000 ms timeout (duration: 5,000.73 ms)
- **Suite counts:** Root group: 3,749 total, 3,747 passed, 1 skipped, 1 failed across 142 files with 16,070 assertions
- **Isolated rerun:** `bun test tests/unit/electron/gateway.test.ts` -> 174 passed, 0 failed; the target passed in 18.30 ms and the file completed in 6.27 seconds
- **Root cause:** The test emitted its only backend event from an arbitrary ten-millisecond timer started immediately after the HTTP request. Under load, that timer could fire before the server had registered the authenticated event-stream client; events are live incremental updates, so the pre-subscription event was correctly not delivered and the promise waited until Bun's outer timeout.
- **Fix:** Wait until the response has received both the connected frame and a keepalive, then emit exactly once through the live stream. This proves registration and still verifies connected, keepalive, and backend-event delivery without treating elapsed time as readiness.
- **Verification:** The old form passed 30 isolated repetitions but retained the structural pre-subscription race. The fixed test passed 50/50 with `bun test tests/unit/electron/gateway.test.ts --test-name-pattern 'delivers backend events to authenticated event streams' --rerun-each 50`; individual runs completed in 9.07-25.18 ms.
