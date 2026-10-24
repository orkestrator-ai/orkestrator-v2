# Container storage marker helper times out in the aggregate

- **ID:** 0672
- **Status:** open
- **Date observed:** 2026-10-22
- **Test:** `storage helper > reports unknown content and foreign markers without touching data`
- **File:** `apps/backend/tests/container-storage.test.ts:165`
- **Original command:** `mise run test:logged -- --name review-final-complete-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reservations 4/1/2/1; two isolated Bun workers for the backend on the shared macOS host.
- **Failure:** the unchanged helper test hit its five-second deadline (5001.60 ms), with one dangling fixture process killed. This was the only failing test in the final workspace group; the other complete-suite groups passed. The complete suite exited 1 after 651.6 s. The preceding complete run passed all workspace packages.
- **Backend suite counts:** 9,990 total: 9,909 passed, 80 skipped, one failed across 571 files (525.58 s).
- **Isolated rerun:** `mise run test:logged -- --name review-storage-owner -- bun test --cwd apps/backend ./tests/container-storage.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 3.4 s).
- **Evidence:** `orkestrator-test-run.TfxXYL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; the outer summary is in `orkestrator-test-run.tzIUpX`.
- **Hypothesis:** the fixture deadline was exceeded under aggregate load; the isolated pass establishes intermittence but does not establish the cause. No helper implementation, test assertion, deadline or skip changed.
- **Recurrence (2026-10-24, node mbp3, load average 19 to 31):** the todo-0050 branch's complete `mise run test` failed it at 5000.61 ms. Rerun alone (`bun test --cwd apps/backend --preload ../../tests/setup-node.ts tests/container-storage.test.ts`), the unchanged owner passed (8 of 8). The branch does not touch container storage.
