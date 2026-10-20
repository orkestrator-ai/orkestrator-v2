# Claude idle admission fixture directory race

- **ID:** 0510
- **Status:** open
- **Date observed:** 2026-10-20
- **Test:** `a warm Claude CLI between turns > failed plan-mode admission rechecks capacity after restoring idle ownership`
- **File:** `bridges/claude-bridge/src/services/session-manager-runtime-idle.test.ts:341`
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`
- **Worker configuration:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; Claude used one Bun worker with the Node preload. Component and isolated application browser validation also ran on the host.
- **Failure:** `EISDIR: illegal operation on a directory, open '<temporary home>/.claude'` while creating the fixture file, before the admission assertion (9.06 ms).
- **Suite counts:** Claude bridge reported 1581 passed, five skipped and one failed across 1587 tests in 74 files.
- **Isolated rerun:** `mise run test:logged -- --name claude-idle-isolated -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-runtime-idle.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 0.5 seconds logged).
- **Evidence:** `orkestrator-test-run.iroGIL/bridges.log.gz` below the host temporary directory.
- **Hypothesis:** another asynchronous fixture operation creates `.claude` after the temporary home is selected. The directory producer is unconfirmed. This resembles the sibling fixture failures in [0473](0473-claude-status-plan-fixture-directory-race.md); no bridge implementation, assertion, timeout or skip changed.
