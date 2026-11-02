# Design duplicate capacity receipt aggregate deadline

- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `design operations: prepare, execute, status and cancel > concurrent duplicates at the frame limit settle with a capacity receipt`
- **File:** `apps/backend/src/core/design/operations.test.ts:92`
- **Original command:** `mise run test:logged -- --name review-default-rerun -- mise run test`; workspace backend parallel workers alongside the root and bridge groups on the shared host.
- **Failure:** failed after 5172.03 ms against the default 5 s test budget; the test creates a canvas near the frame limit and performs durable design operations. No assertion mismatch was printed for this case.
- **Suite counts:** pending aggregate completion when recorded; root group independently finished 3418 pass / 3 fail. No passing aggregate claimed.
- **Isolated rerun:** `mise run test:logged -- --name isolated-workspace-failures -- bun test --cwd apps/backend ./src/core/design/operations.test.ts ./tests/claude-cold-dispatch-restart.test.ts --parallel=1 --only-failures` passed both complete owners in 12.4 s.
- **Target comparison:** the same two owners passed in 12.2 s in a separately installed detached origin/main worktree at `38d55ee14`. This does not reproduce the aggregate timeout on main.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vo7cWm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`.
- **Hypothesis:** shared-host I/O load pushes frame/history persistence past the default deadline; unproven. Production and tests left unchanged.
