# Codex title helper process discovery under aggregate load

- **ID:** 0472
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `Codex session titles > hard-kills a timeout-resistant process before rejecting`
- **File:** `bridges/codex-bridge/src/session-titles.test.ts`
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH, alongside browser validation and other worktrees.
- **Failure:** `waitForProcessPid` timed out finding the fixture's `codex` process; reported duration 1733.45 ms.
- **Evidence:** `orkestrator-test-run.ItrRrn/bridges.log.gz` below the host temporary directory.
- **Owning-file rerun:** `mise run test:logged -- --name merge-codextitle-owner -- bun test ./bridges/codex-bridge/src/session-titles.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 2.7 seconds.
- **Assessment:** confirmed intermittent failure. Shared-host contention is a hypothesis; no implementation, assertion, timeout or skip changed.


## Transcript-history main refresh — 2026-10-24

- **Merge parents:** `109a3a90509f3b5f258881f9004c4fde4747f0a9` and `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`.
- **Original command:** `env -u PORT mise run test:logged -- --name merge-complete-suite -- mise run test`, with the testing guide's GNU-tool PATH and `ORKESTRATOR_TEST_AREA_BASE=0014505caeed69395b3cc996dd541fcc6df12c23`. The default workspace/root/bridge/protocol reservations were 4/1/2/1; Codex used one worker after the bridge group waited 922.7 seconds for host capacity.
- **Suite counts:** Codex reported 2,346 passed, forty skipped and two failed across 2,388 tests in 88 files (109.27 seconds).
- **Failure:** 1302.01 ms; shared-host load exceeded 140 during this validation.
- **Complete unchanged owner:** `env -u PORT mise run test:logged -- --name merge-codex-session-titles-owner -- bun test --cwd bridges/codex-bridge ./src/session-titles.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (exit 0, 6.6 seconds logged).
- **Evidence:** `orkestrator-test-run.YFMbrr/bridges.log.gz` below the host temporary directory after aggregate finalization; outer run `orkestrator-test-run.I7HssJ`.
- **Assessment:** confirmed intermittent recurrence. Host contention remains a hypothesis; no implementation, assertion, deadline or skip changed.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 5.6 s: `mise run test:logged -- --name design-links-owner-codex-titles -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/session-titles.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.
