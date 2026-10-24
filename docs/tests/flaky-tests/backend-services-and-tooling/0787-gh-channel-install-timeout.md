# gh channel install times out in the aggregate

- **ID:** 0787
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `gh channel > installs the newest gh after checking GitHub's checksum and uses it`
- **File:** `apps/backend/src/core/host-maintenance-tasks.test.ts`
- **Original command:** `env -u PORT mise run test:logged -- --name full-test-3 -- mise run test (todo-0050 branch rebased on main at a5d78cfc)`
- **Worker configuration:** the default aggregate runner on node mbp3 (Mac17,6, 18 cores), with other workspaces keeping the host at load average 17 to 38.
- **Failure:** Bun's five-second generic budget at 5035.35 ms.
- **Isolated rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts src/core/host-maintenance-tasks.test.ts` passed the unchanged owner (13 of 13, 0.6 s).
- **Hypothesis:** the fixture's archive extraction and checksum work runs in subprocesses that aggregate load can slow past the generic budget. The branch does not touch host maintenance. No assertion, timeout or skip changed.
