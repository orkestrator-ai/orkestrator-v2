# Re-cached provider retirement assertion varies in the aggregate

- **ID:** 0172
- **Status:** open
- **Date observed:** 2026-09-28
- **Test:** `NativeAgentService shared observations > a re-cached provider is never retired`
- **File:** `apps/backend/src/core/native-agent-service-reconciliation.test.ts:4932`
- **Original command:** `mise run test`, while other worktrees were also testing on the host.
- **Failure:** The aggregate run observed one `retireProvider` call where the test expected none.
- **Isolated rerun:** `mise run test:logged -- --name backend-native-reconciliation -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-reconciliation.test.ts --parallel=1 --only-failures` passed.
- **Second aggregate run:** `mise run test` passed all four groups, including the workspace group.

## Current assessment

The aggregate and isolated results differ. The backend code did not change in this task; the retirement timing needs targeted investigation.
