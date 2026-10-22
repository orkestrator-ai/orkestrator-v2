# Claude idle admission fixture directory race

- **ID:** 0510
- **Status:** resolved
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
- **Root cause:** the fixture's blocking-file write raced asynchronous preference persistence creating `.claude/orkestrator/session-preferences`, as identified for the shared fixture race in [0513](0513-claude-bridge-plan-exit-persistence.md).
- **Fix:** `session-manager-runtime-idle.test.ts` now awaits the shared `blockClaudeConfigDir` helper, which removes the competing directory and retries exclusive file creation on `EEXIST`/`EISDIR`. This retains the admission and capacity assertions.
- **Verification (2026-10-22):** `mise run test:logged -- --name claude-idle-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-runtime-idle.test.ts --parallel=1 --only-failures` passed (0.8 s). The same command with `--test-name-pattern 'failed plan-mode admission rechecks capacity after restoring idle ownership' --rerun-each 100` passed (3.1 s), with no fixture-directory failures. A whole-file `--rerun-each 40` attempt was stopped after other warm-runtime lifecycle cases failed from run 2 onward (MCP conflict, timeouts); that attempt is not passing stress evidence for the full file.
