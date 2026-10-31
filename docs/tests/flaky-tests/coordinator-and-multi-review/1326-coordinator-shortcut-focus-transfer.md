# Coordinator shortcut focus transfer fails in aggregate

- **ID:** 1326
- **Status:** open
- **Date observed:** 2026-10-31
- **Test:** `CoordinatorPanel > focus entry and stopped pointer bubbling transfer shortcut ownership`
- **File:** `apps/web/src/components/projects/CoordinatorPanel.test.tsx`
- **Original command:** `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1 mise run test`. The initial exact `mise run test` retry remained queued behind another worktree's aggregate, so it was cancelled before any group started and retried with the documented concurrency opt-out.
- **Worker configuration:** workspace six slots (web two Bun workers), root one, bridges two, protocol one. Component-browser, Electron, and isolated browser validation also ran on the shared host.
- **Failure:** `select` was last called with `project-1, side-1`, rather than `project-1, conversation-1`, after the stopped-bubbling pointer event (1479.94 ms).
- **Isolated rerun:** `mise run test:logged -- --name reconnect-coordinator-failure-owner -- bun test --cwd apps/web ./src/components/projects/CoordinatorPanel.test.tsx --parallel=1 --only-failures` passed unchanged (35.4 s).
- **Assessment:** aggregate-only intermittence is established for this test. The coordinator component and its tests were not changed by the reconnect review fixes. No root cause is established, and no assertion or timeout was changed.
- **Evidence:** `/tmp/reconnect-fix-full-test-concurrent.log` and the workspace group log in `orkestrator-test-run.ojaEt8` under the host temporary directory.
