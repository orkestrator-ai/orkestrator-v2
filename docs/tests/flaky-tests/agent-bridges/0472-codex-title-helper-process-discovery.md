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

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 5.6 s: `mise run test:logged -- --name design-links-owner-codex-titles -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/session-titles.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.
