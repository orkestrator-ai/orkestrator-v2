# `bridge readiness command > keeps retryable local startup races inside the durable wait` (`apps/backend/src/core/commands-state-sync.test.ts:289`)

- **ID:** 0101
- **Status:** resolved
- **Date observed:** 2026-08-07
- **Original command:** `bun run test` (workspace backend group, `bun test src tests --parallel=2`)
- **Worker configuration:** Two Bun workers in the backend package while the root, bridge, and protocol groups ran concurrently
- **Suite counts:** 1,498 backend tests, 1,496 passed, 2 failed; the other failure was the independently tracked PR-monitor flake above
- **Failure:** Expected the caller-deadline timeout with `retryAfterMs: 1000`, but received the environment-startup-deadline timeout with `retryAfterMs: 500`; failed duration 1001.78 ms
- **Isolated rerun:** `bun test src/core/commands-state-sync.test.ts` from `apps/backend` -> 93 passed, 0 failed with 432 assertions in 8.40 s; the target passed in 1006.90 ms
- **Root cause:** The shared readiness probe and its longest-lived caller expire at the same absolute deadline. Both paths returned public `timed-out` results, but with different messages and retry delays. If aggregate scheduling let the shared probe's retry continuation settle first, its internal environment-startup timeout escaped instead of the caller-deadline contract.
- **Fix:** Normalize a shared-probe timeout at the per-caller boundary. Regardless of whether the shared retry continuation or the caller timer wins at the deadline, `await_bridge_ready` now returns the caller-specific timeout with `retryAfterMs: 1000`; ready and terminal failure results remain unchanged.
- **Verification:** The clock-controlled regression, which deterministically makes the shared timeout settle first, passed 100/100 with `bun test src/core/commands-state-sync.test.ts --test-name-pattern "keeps retryable local startup races inside the durable wait" --rerun-each 100` from `apps/backend`. The owning file passed 93 tests with 432 assertions under `--parallel`; backend typechecking passed; and the final `bun run test` aggregate passed every workspace, root, bridge, protocol-lockfile, and iOS group (40 iOS tests).
