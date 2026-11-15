# Coordinator node launch refusal case times out in the aggregate

- **ID:** 0960
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `launch_coordinator_node_environment > refuses a node without a copy, a disconnected node and this node`
- **File:** `apps/backend/src/core/commands-registry-coordinator-nodes.test.ts:236`
- **Original command:** `mise run test` on `todo-0020-container-state-observation-fb5e330d3136` (`eea6142c0`: container image, entrypoint, an e2e spec, a CI workflow and docs; nothing in the coordinator), macOS 27.0 arm64, Bun 1.4.4, default worker plan; host load average about 18 to 22 from other workers.
- **Failure:** the case exceeded Bun's five-second deadline (5175.23 ms). The same aggregate's other failure was case [0959](../previews-annotations-and-gateway/0959-preview-tunnel-admission-hook-timeout.md).
- **Aggregate evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.PbLvVn/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name coord-node-alone -- bun test --cwd apps/backend ./src/core/commands-registry-coordinator-nodes.test.ts --parallel=1` passed (exit 0, 2.3 s).
- **Hypothesis:** load in the aggregate pushed the case past five seconds. Unconfirmed; the previous `mise run test` on the same branch passed this file. No implementation, assertion, deadline or skip changed.

## Resolution (2026-11-15)

- **Class:** default test budget (A). `src/core/commands-registry-coordinator-nodes.test.ts` sets no budget of its own: no `setDefaultTimeout`, no third-argument or hook timeout, and no wall-clock wait deadline in the test or the helpers it uses.
- **Root cause:** the recorded failure was Bun's former 5 s default per-test/hook budget expiring while the host was loaded; the owner passes alone in a few seconds and nothing it asserts depends on elapsed time.
- **Fix:** none in this file. It now runs under `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`), which sets the default per-test and hook budget to 60 s as a hang watchdog.
- **Reproduced:** no. Under contention with the old budget forced (`mise run test:logged -- --name a0960 -- bun scripts/test-under-contention.ts --core <n> --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-registry-coordinator-nodes.test.ts --timeout=5000`) the owner passed (19.7 s), so six burners on one core did not recreate the aggregate's load.
- **Stress:** the same contention command with `--rerun-each=3` at the new default passed (44.0 s).
