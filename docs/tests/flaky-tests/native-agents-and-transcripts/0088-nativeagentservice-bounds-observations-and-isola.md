# `NativeAgentService > bounds observations and isolates synchronous and asynchronous telemetry failures` (`apps/backend/src/core/native-agent-service.test.ts`)

- **ID:** 0088
- **Status:** resolved
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (workspace backend group: `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the web, web-public, protocol, root, and bridge groups ran concurrently
- **Failure:** The test exceeded Bun's 5,000 ms timeout during the aggregate run
- **Suite counts:** Backend package: 1,514 total, 1,512 passed, 2 failed; the other failure was the deterministic `addressPrompt` assertion corrected in the same change
- **Isolated rerun:** `bun test --cwd apps/backend src/core/native-agent-service.test.ts` -> 161 passed, 0 failed; the target passed in 827.81 ms
- **Root cause:** The test created 520 durable native sessions by calling `adoptNativeAgentSession` serially. Each call read and rewrote the growing `native-agent-sessions.json` file, so aggregate I/O contention could push fixture setup beyond Bun's five-second timeout even though the service assertions themselves were fast.
- **Fix:** Seed the same 520 valid persisted session records in one temporary-file write. This preserves coverage of the 512-request and 64-observation production bounds while removing unrelated quadratic fixture I/O.
- **Verification:** `bun test --cwd apps/backend src/core/native-agent-service.test.ts --test-name-pattern 'bounds observations and isolates synchronous and asynchronous telemetry failures' --rerun-each 20` -> 20 passed, 0 failed; individual runs completed in 24.89-42.60 ms.
