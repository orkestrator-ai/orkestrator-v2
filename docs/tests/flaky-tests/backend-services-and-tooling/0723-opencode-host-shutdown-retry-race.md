# OpenCode host shutdown between database-lock retries

- **ID:** 0723
- **Status:** open
- **Date observed:** 2026-10-24
- **Owner:** `apps/backend/src/core/opencode-host-start.test.ts`
- **Test:** `local OpenCode server starts on one host > shutdown between database-lock attempts prevents a retry spawn`
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=f12cc5a5382417bf1bfbda2a7fd93e0d6013aa95 mise run test:logged -- --name merge-repository -- mise run test`, during the transcript-scroll main merge. Workspace/root/bridges/protocol reserved 4/1/2/1 slots, backend used two workers; component and isolated-stack browser suites shared the host.
- **Failure:** expected rejection containing `shutting down`; received `opencode server exited before becoming healthy (code 1, signal null)` (361.88 ms). The child reported `database is locked` immediately beforehand.
- **Complete unchanged owner rerun:** `mise run test:logged -- --name merge-opencode-host-owner -- bun test --cwd apps/backend ./src/core/opencode-host-start.test.ts --parallel=1 --only-failures` passed, exit 0 (7.8 s logged).
- **Evidence:** host temporary artifact `orkestrator-test-run.k5J28D/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` after aggregate finalization. Overall merge results are recorded in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#transcript-scroll-main-merge--2026-10-24).
- **Hypothesis:** host scheduling may race child exit against database-lock retry recognition and shutdown signaling; the separate owner passed, but the precise cause is unproven. The owner and production host-start module match both merge parents. No implementation, assertion, timeout or skip changed.

- **Final suite counts:** backend 10,675 passed, 77 skipped and eighteen failed across 630 files (789.98 s); repository aggregate exited 1 in 905.6 s. Fourteen failures were the existing OpenCode version mismatch; the other owners and reruns are detailed in the linked merge record.
