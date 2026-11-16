# Claude stale-list deletion tombstone timeout

- **ID:** 9893
- **Status:** resolved
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

## Resolution (2026-11-15)

- **Root cause:** none to fix. The owning test no longer exists. It exercised the
  Claude bridge's stale-list deletion tombstones, which commit `c51d553e4`
  ("remove dead bridge SSE mode, tombstones and unused APIs", #2230, an ancestor of
  `HEAD`) removed together with the writer and reader they covered; that commit also
  deletes `bounds stale-list deletion tombstones to the newest 128 sessions` from
  `session-manager-persistence.test.ts`. Today `rg "deleteSessionDurably|stale-list"
  bridges/claude-bridge/src` finds nothing.
- **Fix:** none beyond that removal. The remaining file's tests also gain the 60 s
  default budget from `tests/default-test-timeout.ts`, which covers the original
  5 s deadline (the file has no smaller explicit timeout).
- **Reproduced:** no. The test cannot run, so there is nothing to reproduce.
- **Stress:** not applicable.
