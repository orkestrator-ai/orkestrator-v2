# Re-cached provider retirement assertion varies in the aggregate

- **ID:** 0172
- **Status:** resolved
- **Date observed:** 2026-09-28
- **Test:** `NativeAgentService shared observations > a re-cached provider is never retired`
- **File:** `apps/backend/src/core/native-agent-service-reconciliation.test.ts:4932`
- **Original command:** `mise run test`, while other worktrees were also testing on the host.
- **Failure:** The aggregate run observed one `retireProvider` call where the test expected none.
- **Isolated rerun:** `mise run test:logged -- --name backend-native-reconciliation -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-reconciliation.test.ts --parallel=1 --only-failures` passed.
- **Second aggregate run:** `mise run test` passed all four groups, including the workspace group.

## Current assessment

The aggregate and isolated results differ. The backend code did not change in this task; the retirement timing needs targeted investigation.

## Resolution (2026-09-30)

The test configured `providerRetirementGraceMs: 0`. The failed observation
evicts the provider and arms a `setTimeout(…, 0)` retirement. The re-cache the
test then performs (`provider(TAB)`) awaits storage twice
(`assertEnvironmentLive`) before `installProvider()` cancels the retirement.
Under load that storage I/O took longer than the zero-length timer, so the
timer fired first and disposed a provider that was about to be re-cached. The
test was racing its own configuration; the product ordering is intended.

The test now uses a 60-second grace, so the retirement stays armed until the
re-cache has to cancel it. It asserts `retiringProviders` holds the provider
after the failed sweep and no longer holds it after the re-cache. It still
asserts that `dispose` was never called. Removing
`cancelProviderRetirement()` from `installProvider()` fails the new assertion
deterministically instead of intermittently.

Verification: the owning test passed 30/30 with `--rerun-each 30` under full-suite load.
