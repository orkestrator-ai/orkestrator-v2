# Cursor SDK boundary diagnostics weak transport snapshot

- **ID:** 0147
- **Status:** open
- **Date observed:** 2026-09-19
- **Test:** `Cursor SDK boundary diagnostics > dispatch reaches the real patched detector and correlates it with the bridge run` (`bridges/cursor-bridge/src/sdk-diagnostics.test.ts`)
- **Original command:** `mise run test` at `1feadf0f7fbcf4679306065d880f53d2bde86590`
- **Worker configuration:** the aggregate bridge group ran Turbo with two package tasks concurrently; Cursor used Bun 1.4.2 with `--parallel=1` while the workspace and root groups also ran.
- **Failure:** `expect(sdkRecord).toMatchObject(...)` received a final `sdk-snapshot` whose only transport was `{ "collected": true }` instead of the expected `inboundCount: 2`, `heartbeatCount: 1`, and `lastInbound: "heartbeat"` (duration: 5.87 ms).
- **Suite counts:** Cursor bridge: 443 total, 442 passed, 1 failed; the aggregate bridge group failed.
- **Isolated rerun:** `mise run test:logged -- --name cursor-sdk-diagnostics-isolated -- bun test ./bridges/cursor-bridge/src/sdk-diagnostics.test.ts --preload ./tests/register-dom.ts --preload ./tests/setup.ts --parallel=1 --only-failures` → passed in 0.3 seconds.
- **Hypothesis:** The test selects the last SDK snapshot after turn completion. Diagnostics deliberately retain the detector through a `WeakRef`; by the final `closed` boundary, aggregate GC can collect the callback-local detector and serialize `{ "collected": true }`. The isolated rerun retained it long enough to expose the activity counters. The assertion should capture the activity-bearing snapshot before the detector becomes weakly unreachable, or deliberately retain the test detector until the assertion.
