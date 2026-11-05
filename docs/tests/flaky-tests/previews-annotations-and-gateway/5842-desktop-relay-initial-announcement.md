# Desktop relay reconnect test assumes every observer saw the initial announcement

- **ID:** 5842
- **Status:** resolved
- **Observed:** 2026-11-05
- **Test:** `a realm's portal and a local window on the relay > a reconnect the ring covers replays exactly once, with no resync`
- **File:** `apps/backend/tests/gateway-desktop-relayed-stream.test.ts`
- **Original command:** `mise run test:logged -- --name fix-real-gateway -- bun test --cwd apps/backend ./tests/gateway-desktop-relayed-stream.test.ts --parallel=1 --only-failures`
- **Original result:** 15 passed, 1 failed, 36 assertions, 4.21 s. At line 494, the portal's resync count was zero rather than one. Evidence: `/tmp/orkestrator-test-run.ip8gSH/fix-real-gateway.log.gz`.
- **Unchanged owning-file rerun:** the same command passed (2.8 s).
- **Cause:** the first listener opens the shared filtered stream. The portal can subscribe after that stream's initial resync announcement was delivered to the window. Joining an already-open stream does not announce again.
- **Fix:** record each observer's initial resync count before disconnecting, then assert that reconnect leaves both counts unchanged. Exact replay and event-count assertions remain in place.
- **Verification:** the same command passed after the fix (3.6 s). Broader default validation remained queued behind another worktree at this point; no aggregate pass is claimed.
