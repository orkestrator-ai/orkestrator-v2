# Claude stale-list deletion tombstone timeout

- **ID:** 0947
- **Status:** open
- **Observed:** 2026-10-26, Codex resume-context review validation
- **Test:** `reconcilePersistedSessions > bounds stale-list deletion tombstones to the newest 128 sessions`
- **File:** `bridges/claude-bridge/src/services/session-manager-persistence.test.ts`

`mise run test:logged -- --name repository-tests -- mise run test` failed
this unchanged test after 5359.28 ms against Bun's 5000 ms deadline. A pending
`deleteSessionDurably` expectation then rejected between tests (expected true,
received false). The bridges group reserved two workers, with one Bun worker
per package. Claude reported 1640 pass, 5 skip, 1 fail and 1 error across
81 files (69.98 seconds).

The complete unchanged owner passed alone, exit 0 in 0.8 seconds:

```sh
mise run test:logged -- --name claude-persistence-isolated -- bun test ./bridges/claude-bridge/src/services/session-manager-persistence.test.ts --preload ./tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: host temporary directory `orkestrator-test-run.unZQTH/bridges.log`
(compressed on aggregate completion), enclosing log
`orkestrator-test-run.2JILAH/repository-tests.log`. No Claude implementation,
test, assertion or deadline changed. Host contention is a hypothesis, not an
established cause. The original aggregate remains failed.
