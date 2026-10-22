# `NativeAgentService > starts and stops the observe-only timer with the service lifecycle` (`apps/backend/src/core/native-agent-service.test.ts`)

- **ID:** 0086
- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun run test` (backend workspace group:
  `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the
  web, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** After initialization made one interaction-list call, the test
  expected a second call after sleeping 130 ms for a 100 ms interval, but the
  call count remained one (`Expected: > 1`, `Received: 1`; 154.69 ms).
- **Suite counts:** Backend package: 1,776 total, 1,775 passed, 1 failed across
  55 files.
- **Isolated rerun:** `bun run test:logged -- --name
  isolate-native-agent-service-timer -- bun --cwd=apps/backend test
  ./src/core/native-agent-service.test.ts --only-failures` → passed.
- **Root cause:** The test assumed sleeping 30 ms beyond the configured timer
  interval guaranteed the callback had run. Aggregate scheduling delayed that
  callback past the fixed sleep even though the lifecycle behavior was intact.
- **Fix:** Poll the observable call-count transition with the file's existing
  two-second bounded helper. The shutdown half retains its fixed observation
  window because it proves that no further timer callback occurs.
- **Verification:** `bun run test:logged -- --name
  stress-native-agent-service-timer -- bun --cwd=apps/backend test
  ./src/core/native-agent-service.test.ts --test-name-pattern "starts and stops
  the observe-only timer with the service lifecycle" --rerun-each 20
  --only-failures` → passed all 20 reruns.
