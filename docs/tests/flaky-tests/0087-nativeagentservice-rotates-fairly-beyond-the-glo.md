# `NativeAgentService > rotates fairly beyond the global live-session adoption cap` (`apps/backend/src/core/native-agent-service.test.ts`)

- **ID:** 0087
- **Status:** resolved
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (workspace backend group: `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the web, web-public, protocol, root, and bridge groups ran concurrently
- **Failure:** The test exceeded Bun's 5,000 ms timeout in two aggregate runs (5,000.03 ms and 5,001.32 ms)
- **Suite counts:** Latest backend package run: 1,519 total, 1,518 passed, 1 failed
- **Isolated rerun:** `bun test src/core/native-agent-service.test.ts` from `apps/backend` -> 161 passed, 0 failed; the target passed in 3,111.70 ms (and 2,400.31 ms after the first observation)
- **Root cause:** The fixture created 1,025 durable native sessions by calling `adoptNativeAgentSession` serially. Each call read and rewrote the growing `native-agent-sessions.json` file, so aggregate I/O contention could push setup beyond Bun's timeout even though the rotation assertions themselves were fast.
- **Fix:** Reuse a bulk fixture helper that writes the same valid 1,025-session snapshot once. This preserves the global 1,024-session cap and second-pass fairness assertions without exercising unrelated quadratic persistence setup.
- **Verification:** `bun test src/core/native-agent-service.test.ts --test-name-pattern "rotates fairly beyond the global live-session adoption cap" --rerun-each 20` from `apps/backend` -> 20 passed, 0 failed; individual runs completed in 36.37-44.93 ms. The complete owning file passed 161 tests, and the final `bun run test` aggregate passed every workspace, root, bridge, protocol-lockfile, and iOS group.
