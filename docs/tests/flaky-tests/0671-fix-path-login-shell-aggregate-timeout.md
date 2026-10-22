# Login-shell PATH merge exceeds the aggregate deadline

- **ID:** 0671
- **Status:** open
- **Date observed:** 2026-10-22
- **Test:** `fixPath > merges login-shell and inherited entries without logging path contents`, `apps/backend/src/core/fix-path.test.ts`.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; workspace ran two package tasks with two Bun workers each alongside other worktrees.
- **Failure:** exceeded 5000 ms (5000.93 ms), killed a dangling process, then produced an unhandled assertion because login-shell PATH entries were missing.
- **Suite counts:** backend: 9901 passed, 80 skipped, five failed and one error across 9986 tests in 571 files (821.53 s). Three failures were outdated Codex subprocess fixtures missing `skills/list`, fixed separately; the other timeout is tracked in 0175.
- **Isolated rerun:** `mise run test:logged -- --name fix-path-isolated -- bun test --cwd apps/backend ./src/core/fix-path.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file (3.1 s logged, exit 0).
- **Evidence:** `orkestrator-test-run.rkxXtB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary root; passing focused output was removed by `test:logged`.
- **Hypothesis:** the login-shell child crossed the five-second test budget under aggregate load, before its PATH output could be merged. The owning file passes alone; the cause remains unproven. No PATH implementation, deadline, assertion or skip changed.
