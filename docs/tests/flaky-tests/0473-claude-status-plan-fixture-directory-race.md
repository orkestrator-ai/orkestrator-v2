# Claude status plan-mode fixture directory race

- **ID:** 0473
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `status frames > a failed plan-mode persistence write keeps the current toggle`
- **File:** `bridges/claude-bridge/src/services/session-manager-system-events.test.ts:270`
- **Original command:** `mise run test:logged -- --name merge2-warm-tests -- mise run test`, with the testing guide's GNU-tool PATH, merging `origin/main` at `f51c7252` into pre-merge HEAD `390667ce`.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots.
- **Failure:** the fixture's `writeFile(<temporary home>/.claude, "not a directory")` failed with `EISDIR` before reaching its persistence assertion (1.28 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge2-claude-system-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-system-events.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.1 seconds.
- **Evidence:** `orkestrator-test-run.ZR4P2k/bridges.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent fixture failure. The producer of the racing directory was not established. No implementation, assertion, timeout or skip changed.

The warm aggregate exited 1 in 307.7 seconds; workspace, root/support and protocol groups passed. This fixture failure was its only failing test. The cold aggregate had passed every bridge; its separate Pi staging timeout passed in an owning-file rerun (see [0178](0178-pi-vendor-runtime-aggregate-timeout.md)).
