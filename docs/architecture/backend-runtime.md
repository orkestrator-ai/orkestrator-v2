# Backend runtime state

Status: Living — `apps/backend/src/core/backend-runtime.ts`,
`terminal-runtime.ts`, `terminal-history.ts`, `local-server-runtime.ts`,
`opencode-agent-tools.ts`, `opencode-host-start.ts`, `pi-catalog-probes.ts`,
`environment-operations.ts`, `environment-replacement-fence.ts`,
`pr-monitor-runtime.ts`, `docker-container-state-cache.ts`,
`diff-stats-tracking.ts`.

One backend instance owns its process state through one `BackendRuntime`.
The backend builds it in `core/index.ts` (`options.runtime ?? new
BackendRuntime(...)`) and hands it to every command as
`CommandContext.runtime`. Command fixtures build a fresh one per context, so
two backends in one process never see each other's terminals, bridges or
environment operations (`backend-runtime.test.ts`).

## Clusters

| Property | Class | Owns |
| --- | --- | --- |
| `diffStats` | `DiffStatsTracking` | Diff-stats tracking, Git freshness, worktree watchers. |
| `terminals` | `TerminalRuntime` | PTYs, session configs, bounded replay buffers and deltas, stable tab keys, orphan reaping, terminal activity timers, and the account homes terminals were launched on (`recordAccountHome`, `isAccountHomeInUse`). `history` (`TerminalHistory`) owns durable terminal history: collectors, configurations, I/O tails, retention and page-read concurrency. |
| `localServers` | `LocalServerRuntime` | Owned bridge processes and their launch facts (worktree, account, token expiry, loginless), renderer bridge tokens, Cursor credential fingerprints, reuse-health markers, stale-login flags, the per-environment and per-container operation queues, and the shutdown gate. `openCodeAgentTools` (`OpenCodeAgentToolsReconciler`) owns OpenCode MCP reconciliation; `openCodeHostStart` (`OpenCodeHostStartGate`) takes host OpenCode starts one at a time and holds the locked-database retry delays; `piCatalog` (`PiCatalogProbes`) owns the Pi catalogue probe's single flight, empty-result backoff and generation counter. |
| `environments` | `EnvironmentOperations` | Setup sessions, the start/setup/baseline dedupe tasks, the per-environment lifecycle queue, and the delete and merge guards. `fence` (`EnvironmentMutationFence`) admits agent work, file writes and worker starts against a runtime replacement or a worktree move. |
| `prMonitor` | `PrMonitorRuntime` | The `PrMonitorService` and its timers, its `external-pr` admission pool (both created on first use), the storage/emit binding of the latest caller, and the serialised sync queue. Merge cleanup is a construction option (`prMonitor.scheduleMergeCleanup`). |
| `containerStates` | `DockerContainerStateCache` | The short-lived `docker ps` snapshot shared by status reads; container creation invalidates it. |
| `changeTracking` | `ChangeTrackingService` | Attached once storage exists; absent in light fixtures. |

`EnvironmentLifecycleTaskTracker` stays a separate context member: it decides
whether lifecycle work may be admitted and drains it on shutdown, while
`EnvironmentOperations` orders and deduplicates admitted work per environment.

## Rules

- Reach state through the context at call time (`context.runtime.terminals`).
  Never destructure the runtime at module load; that froze one instance's state
  into every later caller once already (#417).
- Each class keeps its maps private. Callers use methods named for what they
  do; a read-only accessor is fine where a method would only wrap one lookup.
- Where a module has no context in reach, pass the narrow cluster down
  (`withShortLivedBridge(localServers, ...)`,
  `createEnvironmentCommandRunner(environment, fence)`) or a narrow option
  (`NativeAgentService`'s `localBridgeAccountId` and `environmentFence`), not
  the whole context. An object that outlives one call may keep the cluster it
  was handed at call time (a tmux session keeps the `TerminalRuntime` it
  recorded its account home in).
- Wiring that would otherwise be a module-level registration is a
  construction option too: `index.ts` and the command fixtures pass
  `prMonitor: { scheduleMergeCleanup: scheduleMergeCleanupRecovery }`, so
  `pr-monitor-runtime.ts` never imports `commands-servers.ts`.
- Test seams are construction options, not setters:
  `new BackendRuntime({ emit, terminals: { outputRetentionMs, history: { pageReadHook, serializeHook, maxHistoryDirectories } }, localServers: { spawn, terminateProcessTree, openCodeAgentTools, openCodeLockedStartRetryDelaysMs, piCatalog: { now } }, prMonitor: { scheduleMergeCleanup } })`.
  A test that swaps an implementation mid-test keeps the variable in the test
  and passes a delegating function (`tests/command-fixtures.ts`,
  `localServerHooks`).

## Shutdown

`BackendRuntime.shutdown()` runs once, synchronously, after the gateway stops
accepting commands: it releases diff-stats watchers, change tracking, every
terminal and terminal-history timer, and the PR monitor's polling timers and
admission pool. Terminal history collectors stay usable, because the backend's
awaited `terminals.history.flush(true)` runs later in its shutdown and
persists their last records and checkpoints. Owned local servers need an awaited, ordered teardown, so the
backend's own `shutdown()` calls `runtime.localServers.closeAdmission()` before
draining lifecycle work and `runtime.localServers.shutdown({ operationDrainTimeoutMs })`
after it. SIGINT and SIGTERM reach both through `createBackendShutdownHandler`
(`apps/backend/src/shutdown.ts`).

Module state that still lives outside the runtime (tmux sessions, interactive
terminals, account usage stores, public-API in-flight maps, host-wide Docker
caches and others) is listed in
[0133-backend-module-state-beyond-0066.md](../todo/backend-structure/0133-backend-module-state-beyond-0066.md).
