# Coordinator shortcut focus transfer fails in aggregate

- **ID:** 1326
- **Status:** resolved
- **Date observed:** 2026-10-31
- **Test:** `CoordinatorPanel > focus entry and stopped pointer bubbling transfer shortcut ownership`
- **File:** `apps/web/src/components/projects/CoordinatorPanel.test.tsx`
- **Original command:** `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1 mise run test`. The initial exact `mise run test` retry remained queued behind another worktree's aggregate, so it was cancelled before any group started and retried with the documented concurrency opt-out.
- **Worker configuration:** workspace six slots (web two Bun workers), root one, bridges two, protocol one. Component-browser, Electron, and isolated browser validation also ran on the shared host.
- **Failure:** `select` was last called with `project-1, side-1`, rather than `project-1, conversation-1`, after the stopped-bubbling pointer event (1479.94 ms).
- **Isolated rerun:** `mise run test:logged -- --name reconnect-coordinator-failure-owner -- bun test --cwd apps/web ./src/components/projects/CoordinatorPanel.test.tsx --parallel=1 --only-failures` passed unchanged (35.4 s).
- **Assessment:** aggregate-only intermittence is established for this test. The coordinator component and its tests were not changed by the reconnect review fixes. No root cause is established, and no assertion or timeout was changed.
- **Evidence:** `/tmp/reconnect-fix-full-test-concurrent.log` and the workspace group log in `orkestrator-test-run.ojaEt8` under the host temporary directory.

## Resolution (2026-11-15)

- **Class:** Testing Library's wall-clock wait deadline (B).
- **Root cause:** the failing assertion is a `waitFor(() => expect(select).toHaveBeenLastCalledWith("project-1", "conversation-1"))` after the stopped-bubbling `pointerDown`. `waitFor` gives up after Testing Library's default `asyncUtilTimeout` of 1 s. The recorded 1,480 ms test duration fits that wait expiring on a starved worker before the panel's capture-phase focus handler had issued its `select`. The last call it saw was the earlier `side-1` one.
- **Fix:** `apps/web/src/components/projects/CoordinatorPanel.test.tsx` calls `useAsyncUtilHangWatchdog()` (`apps/web/src/test/async-util-hang-watchdog.ts`) in its top-level `describe`. Each test's `asyncUtilTimeout` becomes a 30 s hang watchdog and is restored after the test. Every `waitFor` in the file waits for a state the panel reaches, and none expects a wait to time out. No assertion changed.
- **Reproduced:** no. The unchanged test passed under `--core 11 --burners 6` with `-t "stopped pointer bubbling" --rerun-each=40` (46.3 s).
- **Stress:**
  - `NODE_ENV=test mise run test:logged -- --name f1326all -- bun scripts/test-under-contention.ts --core 11 --burners 6 -- bun --cwd=apps/web test src/components/projects/CoordinatorPanel.test.tsx` passed the whole file (47.4 s).
  - Ten fresh processes of the test under the same contention (`f1326loop`) passed (75.0 s).
  - The file is not safe for `--rerun-each`. Its second in-process run fails 22 tests on module state, and its first run passes.
