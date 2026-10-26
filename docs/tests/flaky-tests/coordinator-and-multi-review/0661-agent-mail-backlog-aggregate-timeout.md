# Agent mail backlog capacity check exceeds the aggregate deadline

- **ID:** 0661
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `StorageService agent mail > refuses a mailbox whose 200-message backlog has no settled eviction candidate`
- **Owning file:** `apps/backend/src/core/storage-agent-mail.test.ts`
- **Original command:** `mise run test:logged -- --name review-full-suite -- mise run test`, alongside isolated live cold-restart qualification; workspace/root/bridges/protocol reserved 4/1/2/1 slots.
- **Failure:** exceeded the default 5000 ms deadline (5000.83 ms). Backend reported 9739 passed, 67 skipped, three failed and one between-test error across 9809 tests in 551 files (630.83 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name agent-mail-recheck -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/storage-agent-mail.test.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 2.1 seconds logged).
- **Evidence:** `orkestrator-test-run.K1HiOG/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Assessment:** confirmed intermittent failure; concurrent load is an unconfirmed explanation. No implementation, assertion, timeout or skip changed.

- **Recurrence 2026-10-25 (residual module state branch `todo-0066-residual-module-state-40e8f98a7ef0`):** `mise run test` aggregate (reservations 4/1/2/1, backend in the workspace group); timed out at 5001.81 ms. Backend counts: 10963 pass, 84 skip, 1 fail, 11048 tests across 635 files (498.89 s). Artifact `orkestrator-test-run.sBEjBh` under the host temporary directory. The unchanged owner passed alone (`bun test src/core/storage-agent-mail.test.ts` in `apps/backend`: 50 pass, 0 fail, 5.42 s). The branch does not touch agent mail storage.



## Hidden-resume review recurrence — 2026-10-26

- **Failure:** The 200-message backlog refusal exceeded five seconds (5023.13 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name mail-owner -- bun test --cwd apps/backend ./src/core/storage-agent-mail.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (1.4 s logged).
- **Aggregate command, workers, counts and evidence:** [hidden-resume review validation](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#hidden-resume-review-validation--2026-10-26). The backend used two Bun workers; the component suite used nine Playwright workers. Concurrent worktree validation was active.
- **Assessment:** confirmed intermittent recurrence; no owning source, assertion, deadline or skip changed. The original aggregate remains failed; no root cause was established.
