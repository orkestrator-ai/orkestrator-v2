# Coordinator node launch refusal case times out in the aggregate

- **ID:** 0960
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `launch_coordinator_node_environment > refuses a node without a copy, a disconnected node and this node`
- **File:** `apps/backend/src/core/commands-registry-coordinator-nodes.test.ts:236`
- **Original command:** `mise run test` on `todo-0020-container-state-observation-fb5e330d3136` (`eea6142c0`: container image, entrypoint, an e2e spec, a CI workflow and docs; nothing in the coordinator), macOS 27.0 arm64, Bun 1.4.4, default worker plan; host load average about 18 to 22 from other workers.
- **Failure:** the case exceeded Bun's five-second deadline (5175.23 ms). The same aggregate's other failure was case [0959](../previews-annotations-and-gateway/0959-preview-tunnel-admission-hook-timeout.md).
- **Aggregate evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.PbLvVn/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name coord-node-alone -- bun test --cwd apps/backend ./src/core/commands-registry-coordinator-nodes.test.ts --parallel=1` passed (exit 0, 2.3 s).
- **Hypothesis:** load in the aggregate pushed the case past five seconds. Unconfirmed; the previous `mise run test` on the same branch passed this file. No implementation, assertion, deadline or skip changed.
