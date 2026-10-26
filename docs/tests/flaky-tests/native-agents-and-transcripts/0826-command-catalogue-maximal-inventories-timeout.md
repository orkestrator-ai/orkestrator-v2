# Maximal command-catalogue inventories exceed the aggregate deadline

- **ID:** 0826
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `command catalogue under load > 256 maximal inventories stay within the byte budget with exact accounting and LRU eviction`.
- **Owner:** `apps/backend/src/core/native-agent-command-catalogue-scale.test.ts:309`.
- **Original command:** `mise run test:logged -- --name committed-consistency-suite -- mise run test`, on branch `todo-0028-coordinator-consistency-b1b98c1981f1`.
- **Configuration:** two isolated backend workers, with other worktrees validating concurrently on the host.
- **Failure:** timed out at 6643.08 ms against the five-second test deadline. No byte-budget or accounting assertion failure was reported.
- **Complete unchanged owner:** `mise run test:logged -- --name command-catalogue-scale-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-command-catalogue-scale.test.ts --parallel=1 --only-failures` passed, exit 0 in 6.5 seconds.
- **Evidence:** `orkestrator-test-run.iEyQ7i/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** the unchanged owner's isolated pass establishes intermittence. Host scheduling or contention is a hypothesis, not a confirmed root cause. No catalogue code, assertion, timeout or skip changed.

## Remote host upgrades main merge — 2026-10-26

The two-worker backend aggregate repeated the five-second deadline (5517.02 ms). The complete unchanged owner passed alone in 5.9 seconds. Commands, workers, counts and evidence are in [1009](../aggregate-validation-runs/1009-remote-host-main-merge-validation.md). No implementation, assertion, deadline or skip changed.
