# Explicit host-file resolution times out in the aggregate

- **ID:** 0936
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `list_host_directory > resolves explicit files independently of a folder-first capped listing`
- **Owner:** `apps/backend/src/core/commands-host-files.test.ts`
- **Change:** `9b1b42be8` changes CLI voice examples and their tests; no host-file code changed.
- **Original command:** `mise run test:logged -- --name voice-suite -- mise run test`, on macOS arm64 with Bun 1.4.4. Workspace/root/bridges/protocol reserved 4/1/2/1 worker slots; other worktrees were validating on the shared host.
- **Failure:** five-second test deadline exceeded (5034.77 ms); no assertion failure reported.
- **Complete unchanged owner:** `mise run test:logged -- --name host-files-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-host-files.test.ts --parallel=1 --only-failures` passed, exit 0 in 0.9 seconds logged.
- **Aggregate result:** backend 11,431 passed, four failed; web one failure. Other packages, root/support, bridges and protocol passed. Aggregate exit 1 in 1099.1 seconds logged.
- **Evidence:** `orkestrator-test-run.OeJQLs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer log `orkestrator-test-run.S8V2fZ/voice-suite.log.gz`.
- **Assessment:** the owning-file pass establishes intermittence. Shared-host contention is a hypothesis; no implementation, assertion, deadline or skip changed in the owner.
