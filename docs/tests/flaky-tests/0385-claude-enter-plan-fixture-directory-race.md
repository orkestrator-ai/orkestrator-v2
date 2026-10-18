# Claude EnterPlanMode failure fixture already has a directory

- **ID:** 0385
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `plan approval flow > denies EnterPlanMode when its durable preference cannot be written`
- **File:** `bridges/claude-bridge/src/services/session-manager-interactions.test.ts:827`
- **Original command:** `mise run test:logged -- --name main-refresh-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix, merging `origin/main` at `83b78c97` into `5a48bf31`.
- **Workers:** aggregate workspace/root/bridge/protocol reservations of 4/1/2/1 slots; one isolated Bun worker per bridge package on the shared macOS host.
- **Failure:** the fixture's `writeFile` of `.claude` failed with `EISDIR` after 1.24 ms, before invoking `EnterPlanMode` or asserting the denial.
- **Package counts:** Claude reported 1563 passed, five skipped and one failed across 1569 tests in 74 files (40.21 seconds). Every other bridge package passed.
- **Owning-file rerun:** `mise run test:logged -- --name main-refresh-claude-interactions -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.2 seconds.
- **Evidence:** `orkestrator-test-run.BPKKpo/bridges.log.gz` below the platform temporary directory after aggregate completion.
- **Assessment:** the unchanged isolated pass establishes intermittence. Asynchronous session setup may create the directory before the fixture replaces it with a file; this remains a hypothesis. No implementation, assertion, timeout or skip changed.

- **Bridge-group rerun:** `ORKESTRATOR_TEST_WORKERS=1 mise run test:logged -- --name main-refresh-bridges -- bunx turbo run test:bridge --concurrency=2 --continue=dependencies-successful --output-logs=new-only --log-order=stream` passed every bridge package unchanged, exit 0, in 88.1 seconds.

## CLI matrices second main merge — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge2-tests -- mise run test`, macOS arm64, Bun 1.4.3, workspace/root/bridges/protocol reservations 4/1/2/1; component and isolated browser validation ran concurrently.
- **Failure:** the sibling `plan approval flow > keeps plan mode enabled when an approved exit cannot be persisted` case failed in the same fixture write (`session-manager-interactions.test.ts:863`): `.claude` was already a directory (`EISDIR`, 2.06 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge2-claude-interactions-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures` passed unchanged (0.8 seconds logged).
- **Evidence:** `orkestrator-test-run.0J1rem/bridges.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** an intermittent recurrence of the fixture-directory symptom in the exit-plan case; asynchronous session setup remains a hypothesis. No implementation, assertion, timeout or skip changed.

Claude package counts: 1563 passed, five skipped and one failed across 1569 tests in 74 files (70.94 seconds). The other four bridge packages passed.

Aggregate result: `merge2-tests` exited 1 after 1132.1 seconds logged. Backend reported 9081 passed, 41 skipped and 11 failed across 9133 tests in 485 files (1118.57 seconds). Every other workspace package passed; root/support passed 3084 tests with one skip, and protocol regeneration passed. Evidence: `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
