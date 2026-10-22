# Containers and environments

Docker environment containers: platform qualification, rebuild state, network and credential isolation, resource budgets, state observation and cleanup.

Files are ranked by criticality, most critical first. Criticality rates each
file as a whole: the impact of leaving its remaining work undone
([rating a file](../../README.md#rating-a-file)). The items themselves live
in the files. **Finished** is Yes only when every item in the file is done.

| Rank | File | Criticality | Finished | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- |
| 1 | [0018-container-network-and-credential-isolation.md](0018-container-network-and-credential-isolation.md) | High | No | Port/protocol-scoped egress, one canonical default allowlist, and external egress that removes the workload's `NET_ADMIN`. | Containers still spend the host's Claude, OpenCode and Pi refresh tokens, which can sign the host out: a credential-handling defect users hit. |
| 2 | [0019-container-platform-qualification.md](0019-container-platform-qualification.md) | Medium | No | Re-run the live container suites on current `main`; qualify Docker Desktop, rootless, arm64, registry pulls and per-provider session resume. | Docker Desktop, rootless, arm64, registry pulls and per-provider resume after rebuild still lack evidence; the most open work in the folder. |
| 3 | [0020-container-state-observation.md](0020-container-state-observation.md) | Medium | No | Replace fixed-interval `docker exec` polling (Claude state, Files panel, tree walks) with container-side change signals. | Fixed-interval `docker exec` polling costs CPU on every run until change signals replace it; measurements come first. |
| 4 | [0021-container-rebuild-state-preservation.md](0021-container-rebuild-state-preservation.md) | Medium | No | Remaining provider-state preservation gaps across rebuilds; retire the legacy writable-layer, host-mount and policy-1 paths. | Legacy writable-layer, host-mount and policy-1 paths still need retiring with an export path. |
| 5 | [0022-container-resource-budgets-and-performance.md](0022-container-resource-budgets-and-performance.md) | Medium | No | Default per-environment resource budget from measured workloads; deferred container performance options and their evidence bar. | New containers have no measured default CPU, memory and PID budget; the rest is deferred until measured. |
| 6 | [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md) | Low | No | Recorded real-stack pass of environment deletion and pre-ledger sweeps, remaining test temp-dir leaks, surfacing permanently failing cleanup. | The real-stack passes are done; what remains is test temp-dir leaks and surfacing cleanup that keeps failing. |
