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
