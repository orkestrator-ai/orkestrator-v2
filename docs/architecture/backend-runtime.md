# Backend runtime state

Status: Living — `apps/backend/src/core/backend-runtime.ts`,
`terminal-runtime.ts`, `local-server-runtime.ts`, `opencode-agent-tools.ts`,
`environment-operations.ts`, `diff-stats-tracking.ts`.

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
| `terminals` | `TerminalRuntime` | PTYs, session configs, bounded replay buffers and deltas, stable tab keys, orphan reaping, terminal activity timers. |
| `localServers` | `LocalServerRuntime` | Owned bridge processes and their launch facts (worktree, account, token expiry, loginless), renderer bridge tokens, Cursor credential fingerprints, reuse-health markers, stale-login flags, the per-environment and per-container operation queues, and the shutdown gate. `openCodeAgentTools` (`OpenCodeAgentToolsReconciler`) owns OpenCode MCP reconciliation. |
| `environments` | `EnvironmentOperations` | Setup sessions, the start/setup/baseline dedupe tasks, the per-environment lifecycle queue, and the delete and merge guards. |
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
  (`withShortLivedBridge(localServers, ...)`) or a narrow callback
  (`NativeAgentService`'s `localBridgeAccountId` option), not the whole context.
- Test seams are construction options, not setters:
  `new BackendRuntime({ emit, terminals: { outputRetentionMs }, localServers: { spawn, terminateProcessTree, openCodeAgentTools } })`.
  A test that swaps an implementation mid-test keeps the variable in the test
  and passes a delegating function (`tests/command-fixtures.ts`,
  `localServerHooks`).

## Shutdown

`BackendRuntime.shutdown()` runs once, synchronously, after the gateway stops
accepting commands: it releases diff-stats watchers, change tracking and every
terminal timer. Owned local servers need an awaited, ordered teardown, so the
backend's own `shutdown()` calls `runtime.localServers.closeAdmission()` before
draining lifecycle work and `runtime.localServers.shutdown({ operationDrainTimeoutMs })`
after it. SIGINT and SIGTERM reach both through `createBackendShutdownHandler`
(`apps/backend/src/shutdown.ts`).

Module state that still lives outside the runtime is listed in
[0066-backend-residual-module-state.md](../todo/backend-structure/0066-backend-residual-module-state.md).
