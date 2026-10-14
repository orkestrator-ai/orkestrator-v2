# Backend runtime state ownership — plan

Status: Active — not started. Follow-up to the module-boundary guardrails added
on branch `architecture-boundaries-01141669b04a-r1` (2026-10-14).
`import/no-mutable-exports` now stops new `export let`, and
`commands-runtime-state.ts` is on that rule's burn-down allowlist in
`.oxlintrc.json`. This plan takes it off. Land it before the `commands` slice
of [core-domain-folders.md](core-domain-folders.md).

## Problem

`apps/backend/src/core/commands-runtime-state.ts` (793 lines) is the backend's
process-wide state bag. It exports:

- **49 mutable bindings**: 40 `Map`/`Set` instances and 9 `let`s.
- **3 service singletons**: `gitFetchScheduler`, `containerGitFetchPolicy`
  and `diffStatsService`.
- **21 functions**, six of which exist so tests can replace globals:
  `setLocalServerShutdownRequested`, `setLocalServerShutdownPromise`,
  `setTerminateProcessTreeImplementation`,
  `setSpawnLocalServerCommandImplementation`, `setTerminalOutputRetentionMs`
  and `resetTerminalOutputRetentionMs`.

27 production files and 13 test files import it. What that costs:

- **Hidden coupling.** Whether two functions share state shows up only in
  their import lists. `CommandContext` says nothing about terminals or local
  servers, yet most commands depend on them.
- **One backend per process.** Every `CommandContext` in a process shares the
  same maps. Embedded command fixtures (`public-api/test-support.ts`,
  `tests/unit/electron/*`) only stay isolated because `--parallel` gives each
  file its own process. Two backends in one test cannot be told apart.
- **Global clean-up in tests.** Twenty-five test files call
  `shutdownDiffStatsTracking()` just to reset the module singleton between
  tests.
- **Late wiring.** `diffStatsEmit` is an `export let` because "the context
  that carries `emit` only arrives with the first invocation". The backend
  constructs that context in `index.ts`, so owned state can take `emit` in its
  constructor instead.
- **A hidden lazy cycle.** The git-status scan inside the diff-stats service
  loads `commands-files.js` with `await import()` three times (lines ~645–681)
  to dodge a cycle that #417 found. `import/no-cycle` does not see dynamic
  imports.

## Inventory

The bindings split into four clusters. Each cluster has between two and eight
production consumers, so each can move in one PR without a transition period.

| Cluster | Bindings | Production consumers |
| --- | --- | --- |
| **Terminals** | `terminalProcesses`, `terminalSessionConfigs`, `terminalOutputBuffers`, `terminalOutputRevisions`, `terminalOutputGenerations`, `terminalOutputDeltas`, `terminalOutputDeltaBytes`, `terminalOutputTruncated`, `terminalOutputRetentionTimers`, `terminalSessionIdsByStableKey`, `terminalStableKeysBySessionId`, `orphanedTerminalMissingSince`, `terminalActivityTimers`, `terminalActivityArmed`, `terminalActivityGenerations`, `terminalActivityCompletions`, `terminalActivityCompletionStates`, `nextTerminalActivityGeneration`, `terminalOutputRetentionMs` (19) | `commands-terminal` (all); `commands-environment` (`terminalProcesses`, `terminalOutputGenerations`) |
| **Local servers** | `localServerProcesses`, `localServerWorkingDirectories`, the six per-agent bridge token and password maps, `localCursorCredentialFingerprints`, `openCodeAgentToolsConfigurations`, `configuredOpenCodeAgentTools`, `localServerEnvironmentOperations`, `containerBridgeOperations`, `localServerUnresponsiveSince`, `localServerShutdownRequested`, `localServerShutdownPromise`, `terminateProcessTreeImpl`, `spawnLocalServerCommandImpl` (18) | `commands-servers`, `commands-local-server-lifecycle`; also `host-model-catalog-refresh`, `pi-model-catalog-seeding`, `agent-accounts-active` (process map, spawn seam, shutdown flag); `environment-move` (shutdown flag) |
| **Environment operations** | `environmentSetupSessions`, `environmentSetupTasks`, `environmentSetupStartTasks`, `environmentStartTasks`, `environmentLifecycleOperations`, `environmentBaselineTasks`, `deletingLocalServerEnvironments`, `mergingEnvironments`, `mergeCleanupRecoveryTasks` (9) | `commands-environment`, `environment-move`, `docker-cleanup-inventory`, `docker-cleanup-preview`, `commands-local-server-lifecycle`, `commands-terminal`, `commands-review`, `commands-servers` |
| **Diff stats and Git freshness** | `diffStatsEmit`, `diffStatsSyncGeneration`, `diffStatsSyncQueue`, plus the `gitFetchScheduler`, `containerGitFetchPolicy` and `diffStatsService` singletons | `syncDiffStatsTracking` callers (`commands-environment`, `commands-registry-*`, `environment-move`, `public-api/actions-settings`); `invalidatePendingDiffStatsSync`; `invalidateEnvironmentRemoteFreshness` (`commands-review`); `shutdownDiffStatsTracking` (`index.ts`) |

The rest of the file is stateless helpers: `buildOpenCodeGitHubEnvironmentPluginSource`,
`withContainerRuntimeCredential`, `shellPrintfSentinel`,
`buildContainerSafeBase64Reader`, `retryableBridgeStartupError`,
`localServerStopCommandName` and the fingerprint constants. They move next to
their users in step 5 below.

Re-run the inventory before starting:
`git grep -n "commands-runtime-state" apps/backend tests` and the binding list
in the file. The counts above were taken on 2026-10-14.

## Precedent

The pattern this plan follows already exists. `EnvironmentLifecycleTaskTracker`
(`environment-lifecycle-tasks.ts`) is a class with private state:

- The backend creates it in `index.ts`
  (`options.environmentLifecycleTasks ?? new EnvironmentLifecycleTaskTracker()`).
- It is passed as `CommandContext.environmentLifecycleTasks`.
- Test fixtures construct a fresh one (`public-api/test-support.ts`).

Nothing imports its state. Callers go through `admit()` and `shutdown()`.

## Target design

```ts
// core/backend-runtime.ts
export class BackendRuntime {
  readonly terminals: TerminalRuntime;
  readonly localServers: LocalServerRuntime;
  readonly environmentOperations: EnvironmentOperations;
  readonly diffStats: DiffStatsTracking;
  constructor(options: BackendRuntimeOptions) { … }
  async shutdown(): Promise<void> { … }   // replaces scattered shutdown calls
}

// CommandContext gains one field, beside environmentLifecycleTasks:
runtime: BackendRuntime;
```

- **One class per cluster, each owning its maps privately.** Callers use
  methods named for what they do (`terminals.recordOutput(id, chunk)`,
  `localServers.track(key, child)`, `localServers.isShuttingDown()`), not
  `.get()`/`.set()` on a shared `Map`. Where a method would only wrap one map
  operation, a read-only accessor is fine. The aim is a single owner, not
  ceremony.
- **Test seams become constructor options.** `spawnCommand`,
  `terminateProcessTree` and `terminalOutputRetentionMs` are passed in, so a
  test builds a runtime with fakes. All six `set*`/`reset*` functions are
  deleted.
- **`emit` is a constructor argument of `DiffStatsTracking`.** This removes
  `diffStatsEmit` and the reason it was mutable. The three Git/diff singletons
  become fields of that object, and their shutdown becomes part of
  `BackendRuntime.shutdown()`.
- **The backend constructs it once in `index.ts`**
  (`options.runtime ?? new BackendRuntime({ emit, … })`), so embedded fixtures
  can inject one. `public-api/test-support.ts` and `command-fixtures.ts` build
  a fresh one per test, and the `shutdownDiffStatsTracking()` calls in 25 test
  files become fixture teardown.

### Call sites that do not have the context

Most consumers already receive `CommandContext`. Two cases need care:

- `host-model-catalog-refresh`, `pi-model-catalog-seeding` and
  `agent-accounts-active` reach `localServerProcesses` and the spawn seam
  directly. Pass `context.runtime.localServers` through the call chain. If a
  chain is long, take the narrow `LocalServerRuntime` as the parameter rather
  than the whole context.
- `main.ts` shutdown (SIGINT/SIGTERM → `stop`) reaches local servers through
  the backend object, not through module state. Check that the shutdown path
  calls `runtime.shutdown()` exactly once, after the gateway stops accepting
  commands.

### Pitfalls

- **Never destructure the runtime at module load.** Code like
  `const { terminals } = someGlobalRuntime` at module scope recreates the
  value-capture bug #417 fixed (an `Object.assign` snapshot froze `let`
  exports). The runtime is always reached through the context at call time.
- **Timers belong to their owner.** Retention and activity timers must be
  cleared by the owning cluster's `shutdown()`. Tests should find no live
  timers after teardown.
- **Keep identity semantics.** Several maps are keyed by session or
  environment id and read by two clusters (for example `terminalProcesses`
  from `commands-environment`). Give the owning cluster a query method, and do
  not share the map object.

## Steps

Each step is one PR and must not change behaviour. Every step runs
`mise run format:check`, `mise run lint`, `mise run typecheck` and
`mise run test`. Steps 3 and 4 also run `mise run test:agent:browser:isolated`,
because terminals and local servers are visible end to end.

1. **Add `BackendRuntime` and wire it.** Create the empty class and the
   `CommandContext.runtime` field. Construct it in `index.ts` and the fixtures.
   No state moves yet.
2. **Diff stats and Git freshness.** Move the three `let`s and the three
   singletons into `DiffStatsTracking`, which takes `emit` in its constructor.
   Replace the 25 test-file `shutdownDiffStatsTracking()` calls with fixture
   teardown. While here, move the git-status scanner the service calls out of
   `commands-files.ts` (or move the service out of this file), so the three
   `await import("./commands-files.js")` calls disappear.
3. **Terminals.** Move 19 bindings into `TerminalRuntime`. Retention becomes a
   constructor option. `commands-registry-terminal.test.ts` builds a runtime
   instead of calling `setTerminalOutputRetentionMs`.
4. **Local servers.** Move 18 bindings into `LocalServerRuntime`. Spawn and
   terminate become constructor options, and shutdown state becomes private.
   This is the largest step: six consumer modules plus `commands-testing.ts`
   `__testing` helpers, and the tests that set shutdown state
   (`environment-move`, `host-model-catalog-refresh`,
   `pi-model-catalog-seeding`).
5. **Environment operations.** Move nine bindings into
   `EnvironmentOperations`. Consider folding it into
   `EnvironmentLifecycleTaskTracker`, which tracks the same lifecycle. Decide
   when the two are side by side.
6. **Delete the module.** Move the remaining stateless helpers next to their
   users and delete `commands-runtime-state.ts`. Remove it from the
   `import/no-mutable-exports` allowlist in `.oxlintrc.json`. Also remove
   `commands-servers.ts`, `commands-files.ts`, `commands-agent-support.ts` and
   `commands-container-exec.ts` if their entries only existed to re-export or
   forward this state. Check each with the rule turned on.

## Done when

- `commands-runtime-state.ts` no longer exists, and no `set*Implementation`
  or `set*`/`reset*` test seams for backend state remain.
- `CommandContext.runtime` is the only path to terminal, local-server,
  environment-operation and diff-stats state.
- A new test constructs two `BackendRuntime`s in one process and shows that
  a terminal or local server registered in one is invisible to the other.
- The allowlist in `.oxlintrc.json` has shrunk by at least
  `commands-runtime-state.ts`, and `mise run lint` is clean.
- No production code calls `await import()` on a sibling backend module just
  to avoid a cycle.

## Out of scope

The other 44 allowlisted modules, including the bridges' session-manager
state, follow the same pattern but are separate plans. The Claude and Codex
bridges hold 434 exported mutable bindings between them (245 and 189), mostly from the
#417 module split. They need their own inventory before anyone picks them up.
