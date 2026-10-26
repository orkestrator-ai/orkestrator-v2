# Preview tunnel admission case's hook times out in the aggregate

- **ID:** 0959
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `PreviewTunnelServer > admission bounds tunnels per service and releases on close`
- **File:** `apps/backend/src/preview-tunnel-server.test.ts:649`
- **Original command:** `mise run test` on `todo-0020-container-state-observation-fb5e330d3136` (`eea6142c0`: container image, entrypoint, an e2e spec, a CI workflow and docs; nothing in the preview tunnel), macOS 27.0 arm64, Bun 1.4.4, default worker plan; host load average about 18 to 22 from other workers.
- **Failure:** "a beforeEach/afterEach hook timed out for this test" at 5085.96 ms. Backend 11197 passed, 95 skipped and 2 failed across 11294 tests in 655 files (449.09 s); the other failure was case [0960](../coordinator-and-multi-review/0960-coordinator-node-launch-refusal-timeout.md). Every other group passed.
- **Aggregate evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.PbLvVn/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name tunnel-alone -- bun test --cwd apps/backend ./src/preview-tunnel-server.test.ts --parallel=1` passed (exit 0, 1.1 s).
- **Hypothesis:** a hook's server start or close exceeded five seconds under load. Unconfirmed; the previous `mise run test` on the same branch passed this file. No implementation, assertion, deadline or skip changed.
