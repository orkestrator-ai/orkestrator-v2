# Preview runaway: the healthy job after an unbounded allocation times out

- **ID:** 1006
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `runaway execution (process isolation) > unbounded memory allocation: ends within the deadline, the boundary is gone, the next job succeeds`
- **Owning file:** `apps/backend/src/core/transcript-artifacts/preview-runaway.test.ts:315`
- **Original command:** `mise run test` on branch `todo-0033-remote-host-upgrades-e94b3d6c2a08` (base `93018933`), Bun 1.4.4 on Arch Linux x64 (omarchy-hp), default workspace/root/bridges/protocol reservations, host load average 15–17 with other worktrees running suites. The diff touches no transcript-artifact code.
- **Failure:** after 6,685.06 ms, `expect(healthy.ok).toBe(true)` received `false`. The healthy job after the runaway one reported `render_timeout` ("The interactive document did not become ready in time", retry class `after-edit`).
- **Suite counts:** backend 11,709 passed, 142 skipped, 4 failed across 11,855 tests in 703 files (731.65 s).
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts --parallel=2 src/core/transcript-artifacts/preview-runaway.test.ts` from `apps/backend`: 5 passed.
- **Evidence:** `/tmp/orkestrator-test-run.s0jA9M/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` on omarchy-hp.
- **Hypothesis:** host contention (and the memory the runaway case just allocated) slowing the next preview process past its readiness deadline. Not confirmed.
