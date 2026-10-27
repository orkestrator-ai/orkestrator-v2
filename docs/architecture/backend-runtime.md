# Backend runtime state

Status: Living — `apps/backend/src/core/backend-runtime.ts`,
`terminal-runtime.ts`, `terminal-history.ts`, `local-server-runtime.ts`,
`opencode-agent-tools.ts`, `opencode-host-start.ts`, `pi-catalog-probes.ts`,
`environment-operations.ts`, `environment-replacement-fence.ts`,
`pr-monitor-runtime.ts`, `docker-container-state-cache.ts`,
`diff-stats-tracking.ts`, `tmux-runtime.ts`, `agent-accounts-runtime.ts`,
`agent-accounts-last-usage.ts`, `cursor-sdk-login.ts`,
`container-usage-sampler.ts`, `container-oom-events.ts`,
`docker-cleanup-grants.ts`, `integration-locks.ts`, `feature-build-tasks.ts`,
`public-api/reconciliations.ts`, `keyed-single-flight.ts`.

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
| `localServers` | `LocalServerRuntime` | Owned bridge processes and their launch facts (worktree, account, token expiry, loginless), renderer bridge tokens, Cursor credential fingerprints, reuse-health markers, stale-login flags, the per-environment and per-container operation queues, and the shutdown gate. `openCodeAgentTools` (`OpenCodeAgentToolsReconciler`) owns OpenCode MCP reconciliation; `openCodeHostStart` (`OpenCodeHostStartGate`) takes host OpenCode starts one at a time and holds the locked-database retry delays; `piCatalog` (`PiCatalogProbes`) owns the Pi catalogue probe's single flight, empty-result backoff and generation counter; `cursorSdkLogin` (`CursorSdkLoginSlot`) holds the single in-flight Cursor SDK sign-in. |
| `environments` | `EnvironmentOperations` | Setup sessions, the start/setup/baseline dedupe tasks, the per-environment lifecycle queue, and the delete and merge guards. `fence` (`EnvironmentMutationFence`) admits agent work, file writes and worker starts against a runtime replacement or a worktree move. |
| `prMonitor` | `PrMonitorRuntime` | The `PrMonitorService` and its timers, its `external-pr` admission pool (both created on first use), the storage/emit binding of the latest caller, and the serialised sync queue. Merge cleanup is a construction option (`prMonitor.scheduleMergeCleanup`). |
| `tmux` | `TmuxRuntime` | claude-tmux sessions and their install locks (`sessions`), interactive pane terminals (`interactiveTerminals`), Claude state polls (`claudeStatePolls`, registered as the `claude-state-signal` diagnostics source), the serialised activity writes, and the orphaned-session sweep's clock and first-seen times. A session's poll loop reaches it through the context it was started with. |
| `accounts` | `AgentAccountsRuntime` | The last plan-usage readings (`lastUsage`, `AgentAccountLastUsage`), the login keeper's refreshers (construction options) and the coordinator homes whose Keychain login was already removed. |
| `containerStates` | `DockerContainerStateCache` | The short-lived `docker ps` snapshot shared by status reads; container creation invalidates it. |
| `containerUsage` | `ContainerUsageSampler` | The shared container usage sample. It lists only this backend's owner-labelled containers, so it is per backend. |
| `containerOom` | `ContainerOomEvents` | The `docker events` OOM follower, started by the backend once it knows its Docker owner namespace. |
| `dockerCleanupGrants` | `DockerCleanupGrants` | Reviewed Docker cleanup selection tokens (at most eight, ten minutes each, consumed on use). |
| `integrationLocks` | `IntegrationLocks` | GitHub and Linear completion comments per pipeline, workflow-label setup per repository and status updates per issue. The GitHub client functions take the narrow `GitHubWriteLocks`. |
| `featureBuilds` | `FeatureBuildTasks` | Feature-build ticket resolutions per request and background title refinements per ticket. |
| `publicApi` | `PublicApiReconciliations` | The public API's in-flight run observations and exec reconciliations per operation. |
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
  `prMonitor: { scheduleMergeCleanup: scheduleMergeCleanupRecovery }` and
  `tmux: { localClaudeConfigDirectory: tmuxLocalClaudeConfigDirectory }`, so
  neither `pr-monitor-runtime.ts` nor the tmux modules import
  `commands-servers.ts`. `index.ts` also passes the Claude state doorbell
  (`tmux.claudeStatePolls.signal`, from `backendClaudeStateSignal()`) and its
  login keeper's refreshers (`accounts.localClaudeLoginRefresher`,
  `hostClaudeLoginRefresher`, `localCodexLoginRefresher`) as closures that
  return `undefined` while no keeper runs, which callers read as "nothing
  was asked".
- Test seams are construction options, not setters:
  `new BackendRuntime({ emit, terminals: { outputRetentionMs, history: { pageReadHook, serializeHook, maxHistoryDirectories } }, localServers: { spawn, terminateProcessTree, openCodeAgentTools, openCodeLockedStartRetryDelaysMs, piCatalog: { now } }, prMonitor: { scheduleMergeCleanup }, tmux: { localClaudeConfigDirectory, claudeStatePolls, interactiveTerminals }, accounts: { localClaudeLoginRefresher, hostClaudeLoginRefresher, localCodexLoginRefresher } })`.
  A test that simulates a backend restart builds a fresh runtime (or the
  owner class, such as `new AgentAccountLastUsage()`).
  A test that swaps an implementation mid-test keeps the variable in the test
  and passes a delegating function (`tests/command-fixtures.ts`,
  `localServerHooks`).

## Shutdown

`BackendRuntime.shutdown()` runs once, synchronously, after the gateway stops
accepting commands: it releases diff-stats watchers, change tracking, every
terminal and terminal-history timer, the PR monitor's polling timers and
admission pool, the Claude state polls and interactive pane timers, and the
OOM follower. tmux sessions themselves outlive the backend and are left
running. Terminal history collectors stay usable, because the backend's
awaited `terminals.history.flush(true)` runs later in its shutdown and
persists their last records and checkpoints. Owned local servers need an awaited, ordered teardown, so the
backend's own `shutdown()` calls `runtime.localServers.closeAdmission()` before
draining lifecycle work and `runtime.localServers.shutdown({ operationDrainTimeoutMs })`
after it. SIGINT and SIGTERM reach both through `createBackendShutdownHandler`
(`apps/backend/src/shutdown.ts`).

## Process-wide on purpose

Some module state describes the host or the Docker daemon, not one backend,
so two backends in one process share it. Each is marked next to its
declaration:

| Module | State | Why it stays |
| --- | --- | --- |
| `container-resources.ts` | `capacityCache`, `diskCache` | `docker info` and `docker system df` describe the daemon. (The usage sample is owner-filtered and moved to `containerUsage`.) |
| `docker-image.ts` | `manifestCache`, `topologyCache` | Keyed by image, and the daemon's topology. |
| `git-docker-scan-pool.ts` | `gitDockerScanPool` | Bounds Git and Docker work on the host; a pool per backend would multiply the bound. |
| `change-tracking/environment-projector.ts` | `gitVersionPromise` | The host's Git version. |
| `change-tracking/legacy-payload.ts` | `compatibilityCache` | A bounded memo of a pure function of its content key. |
| `design/export-writer.ts` | `destinationLocks`, `destinationOperations` | Serialise writes to one file on the host; the cap bounds the process. |
| `gateway-support-core.ts` | `activeDynamicCompressions` | CPU-bound compression admission per process (gateway, not core; still on the `import/no-mutable-exports` allowlist). |
| `environment-cleanup.ts` | `loggedKeptBranches` | Only de-duplicates a log line. |

`public-api/reconciler.ts` (`reconcilers`) is a registry of functions filled
at module load, the same for every backend: code wiring, not state.

Further per-backend module state found while doing 0133 (agent-account
logins and usage caches, container login pushes, the plan-usage cache's
active account, the GitHub CLI and OpenCode provider logins, the container
log service and OpenCode command journals) is listed in
[0390-backend-module-state-beyond-0133.md](../todo/backend-structure/0390-backend-module-state-beyond-0133.md).
