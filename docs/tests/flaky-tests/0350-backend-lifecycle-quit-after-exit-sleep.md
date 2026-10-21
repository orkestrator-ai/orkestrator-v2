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

## Related shutdown-deadline recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-full-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix, merging `origin/main` into `f2971d54`; workspace/root/bridges/protocol reserved 4/1/2/1 slots, with two isolated workers for desktop and other worktrees sharing the host.
- **Test:** `desktop backend lifecycle > quits anyway when the backend outlives its exit deadline`, `apps/desktop/tests/backend-lifecycle.test.ts:122`.
- **Failure:** after a 10 ms shutdown deadline and `Bun.sleep(60)`, `state.quits` was still 0 instead of 1 (103.08 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge-desktop-lifecycle-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/backend-lifecycle.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.1 seconds.
- **Evidence:** `orkestrator-test-run.B1tmFx/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent observation in the same shutdown owner. Shared-host scheduling beyond fixed sleeps remains a hypothesis; no source, assertion, timeout or skip changed.

## Lifecycle error-context coverage validation — 2026-10-21

- **Command:** `mise run test:logged -- --name full-suite -- mise run test` at `5442a172b` plus renderer regression tests. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; desktop used two isolated workers.
- **Test:** `desktop backend lifecycle > quits anyway when the backend outlives its exit deadline`, `apps/desktop/tests/backend-lifecycle.test.ts:122`.
- **Failure:** expected one quit after the 10 ms deadline and `Bun.sleep(60)`, received zero (78.24 ms).
- **Suite result:** aggregate exited 1 after 435.3 seconds with this failure and the backend cleanup failure in case 0261. Root/support, bridges and protocol passed.
- **Owning-file rerun:** `mise run test:logged -- --name desktop-lifecycle-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/backend-lifecycle.test.ts --parallel=1 --only-failures` passed unchanged, exit 0 in 0.2 seconds.
- **Evidence:** `orkestrator-test-run.7BXWb1/full-suite.log.gz` and `orkestrator-test-run.wdkpxS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** recurrence of the recorded fixed-sleep timing flake; shared-host scheduling remains an unconfirmed hypothesis. No production code, assertions, timeouts or skips changed in this owner.
