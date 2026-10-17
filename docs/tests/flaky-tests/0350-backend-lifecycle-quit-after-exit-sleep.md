# Backend shutdown quit not observed five milliseconds after the backend exits

- **ID:** 0350
- **Status:** open
- **Date observed:** 2026-10-17
- **File:** `apps/desktop/tests/backend-lifecycle.test.ts`.
- **Test:** `desktop backend lifecycle > stops the backend once and holds the quit until it has exited`.
- **Original command:** `mise run test` (desktop `test:workspace`, two parallel workers), on branch `fix-pi-login-in-agent-test-profiles-379ebff75838` at `9da80451` plus uncommitted changes that do not touch the backend shutdown code. Host load average was about 32 because other environments were running live tests.
- **Failure:** `expect(state.quits).toBe(1)` at line 109 received `0` (70.63 ms). The test resolves the backend's exit promise, waits `Bun.sleep(5)`, then expects the held quit to have been re-issued.
- **Suite result:** desktop failed with this test and case 0258; backend failed with case 0151.
- **Owning-file rerun:** `bun test --preload ../../tests/setup-node.ts ./tests/backend-lifecycle.test.ts` from `apps/desktop` passed unchanged (5 pass, 0 fail, 135 ms).
- **Evidence:** `/tmp/pi-login-fix-379e/test-all.log` (local, not retained).
- **Assessment:** isolated pass confirms intermittence. The likely cause is the fixed 5 ms wait between `exited.resolve()` and the assertion, which a loaded host can exceed before the quit continuation runs. Root cause is unconfirmed. No implementation, assertion, timeout or skip changed.
