# Virtuoso post-scroll watch expiry under load

- **ID:** 0381
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `useVirtuosoScrollState > scrollToBottom post-scroll watch window > stops watching scrollHeight after the watch window expires` (`tests/unit/hooks/useVirtuosoScrollState.test.ts:2266`).
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix.
- **Workers:** aggregate workspace/root/bridges/protocol groups used 4/1/2/1 slots alongside browser suites and other worktrees.
- **Failure:** expected one scroll call, received two after the watch window; duration 602.98 ms. Root group reported 3053 passed, 1 skipped and 2 failed across 3056 tests in 966.29 seconds. The other failure was the missing README installer example, subsequently restored and verified separately.
- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-scroll-owner -- bun test ./tests/unit/hooks/useVirtuosoScrollState.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 3.3 seconds.
- **Evidence:** `orkestrator-test-run.iFuHsy/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Assessment:** intermittent timing observation. Host contention is a hypothesis; no scroll implementation, timeout, assertion or skip changed.
