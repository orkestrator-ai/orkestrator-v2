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
