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


## Coordinator adapter review — 2026-10-24

The aggregate repeated this case during coordinator adapter validation. Exact
commands, timing, owner rerun results and evidence are recorded in
[0725](../aggregate-validation-runs/0725-coordinator-adapter-review-validation.md).
The owning implementation, assertions, timeouts and skips were unchanged.

## Claude plugin MCP branch — 2026-10-25

Recurred in a four-worker backend run on the todo 0121 branch
(`cd apps/backend && bun test --preload ../../tests/setup-node.ts src tests --parallel=4`;
backend 11,302 passed, 85 skipped, 13 failed). The unchanged owning file
passed alone (9 pass, 0 fail; same expected `shutting down`, received `opencode server exited before becoming healthy` failure in the aggregate). The branch does not touch this owner; no
implementation, assertion, timeout or skip changed.
