# Docker registry credential error fixture exceeds the aggregate deadline

- **ID:** 0766
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `Electron backend command registry > does not expose configured credentials in Docker argv or container creation errors` in `apps/backend/tests/commands-registry-docker.test.ts:140`.
- **Original command:** `mise run test:logged -- --name merge-backend-complete -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src ./tests --parallel=2 --only-failures`, on the merged `74387453` / `0014505ca` tree, Bun 1.4.3 on the shared macOS host.
- **Failure:** the case exceeded five seconds (5040.63 ms); its error-between-tests expected `Docker permission denied` but received the bounded uncertain-creation/reconciliation error. No credential values were printed in this record.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-docker-registry-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-docker.test.ts --parallel=1 --only-failures` passed, exit 0 in 47.8 s logged.
- **Suite counts:** 10670 passed, 115 skipped, 16 failed and one error across 10801 tests in 636 files (1199.8 s). Fourteen failures were exact-main OpenCode version assertions; the other failure was the observation baseline.
- **Evidence:** `orkestrator-test-run.BDDGcj/merge-backend-complete.log.gz` under the host temporary directory after run finalization. Aggregate counts are recorded in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#mixed-version-compatibility-main-merge--2026-10-24).
- **Hypothesis:** the fake Docker child or its reconciliation exceeded the fixed deadline under shared-host load; the current evidence does not identify which wait was delayed. The owner passed unchanged with one worker. No implementation, assertion, timeout or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation. The file uses `ASYNC_TEST_BUDGET_MS` for five other cases; this case uses Bun's default five seconds while it drives the fake Docker child and its reconciliation.
- **Next step:** give the case the same explicit budget.


## Direct-history cursor review validation — 2026-10-27

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1; other worktrees were validating on the shared host.
- **Failures:** `Electron backend command registry > does not expose configured credentials in Docker argv or container creation errors` exceeded five seconds (5,004.57 ms), then expected `Docker permission denied` but received the uncertain-creation/reconciliation error between tests. `matches short and full container IDs before removing orphaned Docker containers` and `resolves a container's display name through its environment id when the name label is stale` also exceeded five seconds (5,007.46 and 5,003.41 ms); late Docker list calls reported `SIGTERM`.
- **Owning-file rerun:** `mise run test:logged -- --name docker-registry-owner -- bun test --cwd apps/backend ./tests/commands-registry-docker.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 12.7 s).
- **Evidence:** `orkestrator-test-run.wESThp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion. Aggregate results are recorded in [1140](../aggregate-validation-runs/1140-direct-history-cursors-0232-validation.md).
- **Assessment:** credible recurrence with two additional Docker command cases in the same owner. Shared-host subprocess contention is plausible but unproven; no implementation, assertion, deadline or skip changed.
