# Backend runtime state

Status: Living — `apps/backend/src/core/backend-runtime.ts`,
`terminal-runtime.ts`, `terminal-history.ts`, `local-server-runtime.ts`,
`opencode-agent-tools.ts`, `opencode-host-start.ts`, `pi-catalog-probes.ts`,
`environment-operations.ts`, `environment-replacement-fence.ts`,
`pr-monitor-runtime.ts`, `docker-container-state-cache.ts`,
`diff-stats-tracking.ts`, `tmux-runtime.ts`, `agent-accounts-runtime.ts`,
`agent-accounts-last-usage.ts`, `plan-usage-cache.ts`, `cursor-sdk-login.ts`,
`github-cli-login.ts`, `opencode-provider-login-slot.ts`,
`container-usage-sampler.ts`, `container-oom-events.ts`,
`container-log-service.ts`,
`docker-cleanup-grants.ts`, `integration-locks.ts`, `feature-build-tasks.ts`,
`public-api/reconciliations.ts`, `keyed-single-flight.ts`,
`coordinator-request-flights.ts`, `opencode-coordinator-research.ts`.

One backend instance owns its process state through one `BackendRuntime`.
The backend builds it in `core/index.ts` (`options.runtime ?? new
BackendRuntime(...)`) and hands it to every command as
`CommandContext.runtime`. Command fixtures build a fresh one per context, so
two backends in one process never see each other's terminals, bridges or
environment operations (`backend-runtime.test.ts`; the state moved by todo 1070 in
`backend-runtime-module-state.test.ts`).

## Clusters

| Property | Class | Owns |
| --- | --- | --- |
| `diffStats` | `DiffStatsTracking` | Diff-stats tracking, Git freshness, worktree watchers. |
| `terminals` | `TerminalRuntime` | PTYs, session configs, bounded replay buffers and deltas, stable tab keys, orphan reaping, terminal activity timers, and the account homes terminals were launched on (`recordAccountHome`, `isAccountHomeInUse`). `history` (`TerminalHistory`) owns durable terminal history: collectors, configurations, I/O tails, retention and page-read concurrency. |
| `localServers` | `LocalServerRuntime` | Owned bridge processes and their launch facts (worktree, account, token expiry, loginless), renderer bridge tokens, Cursor credential fingerprints, reuse-health markers, stale-login flags, the per-environment and per-container operation queues, and the shutdown gate. `openCodeAgentTools` (`OpenCodeAgentToolsReconciler`) owns OpenCode MCP reconciliation and, as `research` (`OpenCodeCoordinatorResearch`), the coordinator research registrations it forgets with the same keys; `openCodeHostStart` (`OpenCodeHostStartGate`) takes host OpenCode starts one at a time and holds the locked-database retry delays; `piCatalog` (`PiCatalogProbes`) owns the Pi catalogue probe's single flight, empty-result backoff and generation counter; `cursorSdkLogin` (`CursorSdkLoginSlot`) holds the single in-flight Cursor SDK sign-in; `gitHubCliLogin` (`GitHubCliLoginSlot`) the single in-flight GitHub CLI sign-in, which isolates progress and cancellation only, since `gh auth login` writes the host's `gh` configuration; `openCodeProviderLogin` (`OpenCodeProviderLoginSlot`) the OpenCode provider sign-in, the reservation that lets one login change run at a time and the provider list single flight. |
| `environments` | `EnvironmentOperations` | Setup sessions, the start/setup/baseline dedupe tasks, the per-environment lifecycle queue, the project-home ensures per project, the allowlist apply queue per environment, the environments a stop is draining (`container-readiness.ts` fences their containers), container replacement cancellations, and the delete and merge guards. `fence` (`EnvironmentMutationFence`) admits agent work, file writes and worker starts against a runtime replacement or a worktree move. |
| `prMonitor` | `PrMonitorRuntime` | The `PrMonitorService` and its timers, its `external-pr` admission pool (both created on first use, because every pool registers in the process-wide diagnostics registry, capped at `MAX_DIAGNOSTIC_SOURCES` = 32, and most test runtimes never monitor a PR), the storage/emit binding of the latest caller (not the runtime's own `emit`, so tests that capture events through their context still see them), and the serialised sync queue. Merge cleanup is a construction option (`prMonitor.scheduleMergeCleanup`). |
| `tmux` | `TmuxRuntime` | claude-tmux sessions and their install locks (`sessions`), interactive pane terminals (`interactiveTerminals`), Claude state polls (`claudeStatePolls`, registered as the `claude-state-signal` diagnostics source), the serialised activity writes, and the orphaned-session sweep's clock and first-seen times. A session's poll loop reaches it through the context it was started with. |
| `accounts` | `AgentAccountsRuntime` | The account mutation chain (`withMutation`), the single in-flight sign-in, per-account usage and its generations, the plan-usage cache and active account (`planUsage`, `PlanUsageState`) with the reader over them (`readPlanUsage`), the last plan-usage readings (`lastUsage`, `AgentAccountLastUsage`), what was pushed into each container, the host's MCP refresh digests (`hostMcpRefreshDigests`), the login keeper's refreshers (construction options) and the coordinator homes whose Keychain login was already removed. |
| `containerStates` | `DockerContainerStateCache` | The short-lived `docker ps` snapshot shared by status reads; container creation invalidates it. |
| `containerUsage` | `ContainerUsageSampler` | The shared container usage sample. It lists only this backend's owner-labelled containers, so it is per backend. |
| `containerOom` | `ContainerOomEvents` | The `docker events` OOM follower, started by the backend once it knows its Docker owner namespace. |
| `containerLogs` | `ContainerLogService` | The `docker logs -f` followers behind `open_container_logs`/`read_container_logs`, their replay rings and subscription leases. Constructing it starts nothing; the lease sweep starts with the first subscription. |
| `dockerCleanupGrants` | `DockerCleanupGrants` | Reviewed Docker cleanup selection tokens (at most eight, ten minutes each, consumed on use). |
| `integrationLocks` | `IntegrationLocks` | GitHub and Linear completion comments per pipeline, workflow-label setup per repository and status updates per issue. The GitHub client functions take the narrow `GitHubWriteLocks`. |
| `featureBuilds` | `FeatureBuildTasks` | Feature-build ticket resolutions per request and background title refinements per ticket. |
| `publicApi` | `PublicApiReconciliations` | The public API's in-flight run observations and exec reconciliations per operation. |
| `coordinatorRequests` | `CoordinatorRequestFlights` | Coordinator receipt attempts per coordinator and request id (`withCoordinatorReceipt`) and AGENTS.md pull request runs per request key. |
| `changeTracking` | `ChangeTrackingService` | Attached once storage exists; absent in light fixtures. |

The graph engine's system actions keep their memory on the system executor
rather than on the runtime: `GraphNodeSystemExecutor`, which the backend
builds once, holds a `GraphSystemActionMemory` (effect locks per run and key,
`wait-for-checks` final-read failures per activation) and hands it to every
action context.

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
  `createGitEnvironmentCommandRunner(environment, fence)`,
  `ensureProjectHomeEnvironment(environments, ...)`,
  `withEnvironmentDraining(environments, ...)`,
  `openAgentsMdPullRequest(coordinatorRequests, ...)`) or a narrow option
  (`NativeAgentService`'s `localBridgeAccountId`, `environmentFence` and
  `openCodeCoordinatorResearch`, a
  bridge provider's `planUsage`, `gitHubCliEnv`'s config source), not the whole
  context. An object that outlives one call may keep the cluster it
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
  `new BackendRuntime({ emit, terminals: { outputRetentionMs, history: { pageReadHook, serializeHook, maxHistoryDirectories } }, localServers: { spawn, terminateProcessTree, openCodeAgentTools, openCodeLockedStartRetryDelaysMs, piCatalog: { now } }, prMonitor: { scheduleMergeCleanup }, tmux: { localClaudeConfigDirectory, claudeStatePolls, interactiveTerminals }, accounts: { localClaudeLoginRefresher, hostClaudeLoginRefresher, localCodexLoginRefresher }, containerOom: { spawn }, containerLogs: { spawn, now } })`.
  A test that runs whole backends passes the two Docker follower seams to
  `OrkestratorBackend` as `dockerFollowers`, which keeps the backend's own
  refresher wiring (passing a whole `runtime` would replace it).
  A test that simulates a backend restart builds a fresh runtime (or the
  owner class, such as `new AgentAccountLastUsage()`).
  A test that swaps an implementation mid-test keeps the variable in the test
  and passes a delegating function (`tests/command-fixtures.ts`,
  `localServerHooks`).

Two module-level test seams stay on purpose, each marked next to its
declaration. `setAgentSkillsHomeForTesting` (`agent-skills.ts`) redirects the
home directory, because `os.homedir()` ignores `$HOME` under Bun; the home
belongs to the process, and a runtime option would put the runtime in every
skills lookup. `setStorageVolumeOptionsForTest` (`container-storage.ts`) injects
driver options for one live disk-exhaustion test; no command reaches it. Tests
that set either must reset it.

## Shutdown

`BackendRuntime.shutdown()` runs once, synchronously, after the gateway stops
accepting commands: it releases diff-stats watchers, change tracking, every
terminal and terminal-history timer, the PR monitor's polling timers and
admission pool, the Claude state polls and interactive pane timers, the OOM
follower and the container log followers (observers: stopping them never
touches a container). The backend also stops those two followers explicitly
in its own `shutdown()`; both stops are idempotent. Only this backend's
followers stop: two backends in one process each keep their own, and one's
shutdown leaves the other's OOM counts, log subscriptions and login
refreshers running (`backend-runtime.test.ts`, "two OrkestratorBackends in
one process"). tmux sessions themselves outlive the backend and are left
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
| `design/export-writer.ts` | `destinationLocks`, `destinationOperations` | Serialise writes to one file on the host; the cap bounds the process. Keyed by destination path, not by backend: a copy per backend would let two backends write the same file at once. |
| `gateway-support-core.ts` | `activeDynamicCompressions` | CPU-bound compression admission per process: the bound protects the host's CPU, so a counter per backend would multiply it (gateway, not core; still on the `import/no-mutable-exports` allowlist for this binding). |
| `disk-usage.ts` | `running`, `waiting` | Bound disk scans on the host, like `gitDockerScanPool`; a bound per backend would multiply it. |
| `transcript-artifacts/interactive-modules.ts` | `macroCheck` | A fact about this Bun: whether it honours `macros: false`. |
| `storage-agent-mail.ts` | `lastIdTime`, `idSequence` | One clock orders mail ids across every repository in the process, a stronger guarantee than one per repository; it shares nothing but ordering. |
| `opencode-command-changes.ts` | `sharedProbe` | Orders snapshots per repository on the host, so two providers on one worktree must share it. |
| `opencode-command-changes.ts` | `journals`, `removedJournalDirectories` | Keyed by paths inside a backend's data directory, so two data directories never share an entry. The removed set gains one entry per deleted OpenCode environment for the life of the process. |
| `agent-test-cursor-credential.ts` | `hostCursorCredential` | Agent-test profiles only: the process entry loads it once from its own data directory, so two agent-test backends in one process would see one key. |
| `container-lifecycle-service.ts` | `activeOperations`, `operationClocks` | Keyed by the data directory's Docker owner namespace and the operation id, so two data directories never share an entry. |
| `container-lifecycle-service.ts` | `ownedByLabel` | A bounded memo of a container's owner label, which is immutable; a hit counts only for the owner the caller asks with. |
| `container-network-owner.ts` | `networkOwners` | A container's network mode, a fact about the daemon. |
| `container-readiness.ts` | `drainingContainers` | A container id names one Docker container: new work into a container that is stopping is refused whichever backend asks. The draining environments are on `runtime.environments`. |
| `environment-cleanup-ledger.ts` | `connections`, `ledgers`, `sweepStates` | Keyed by the resolved data directory; backends that share one share its database too. |
| `environment-cleanup-reconciler.ts` | `exhaustedWarnings`, `loggedSweepFailures` | Only de-duplicate log lines. |
| `environment-cleanup-reconciler.ts` | `reportedStrayWithContent`, `scheduled` | Keyed by the resolved data directory. |
| `bug-report-service.ts` | `filingFlights` | Keyed by data directory and report id. |
| `git-fsmonitor.ts` | `fsmonitorMigrations` | Keyed by worktree path: the migration edits that worktree's config file on the host. |
| `shell.ts` | `commandInvocations`, `commandObservers` | Count this process's own subprocesses for benchmarks; `runCommand` has no backend in reach. |
| `transcript-artifacts/preview-supervisor.ts` | `backendStartIdentity` | The start identity of this process, which names the preview scratch it owns. |
| `transcript-artifacts/dependency-manifest.ts` | `cache` | Verified bytes of a pinned bundle file, keyed by bundle and directory. |
| `control-mcp-direct-tools.ts` | `compiled` | Schemas compiled from constants. |

`public-api/reconciler.ts` (`reconcilers`) is a registry of functions filled
at module load, the same for every backend: code wiring, not state.

The export-writer locks and `activeDynamicCompressions` were once proposed
to move per backend; they stay because each bounds or orders host
resources, not one backend's work.

Three pieces of module state are per backend but not yet moved, each marked
next to its declaration: `github-cli-binary.ts` (`managedGitHubCli`),
`host-model-catalog-seed.ts` (`failedAt`, `generations`, `flights`) and
`worker-tab-close-admission.ts` (`closing`, `pending`). They are tracked in
[1070-backend-module-state-beyond-0390.md](../todo/backend-structure/1070-backend-module-state-beyond-0390.md).
