# Backend runtime state ownership

Checked against `main` at `2459b05c` (2026-10-15).

`apps/backend/src/core/commands-runtime-state.ts` is the backend's
process-wide state bag: terminal, local-server and environment-operation maps
exported as module globals, plus setters that exist so tests can replace them.
Whether two functions share state shows up only in their import lists, and
every `CommandContext` in one process shares the same maps, so two backends in
one test cannot be told apart. The goal is to move that state into the
per-backend `BackendRuntime` reached through `CommandContext.runtime`, delete
the module, and take it off the `import/no-mutable-exports` allowlist.

## Current state

- `BackendRuntime` (`apps/backend/src/core/backend-runtime.ts`, #978) is
  constructed once in `core/index.ts`
  (`options.runtime ?? new BackendRuntime(...)`), passed as
  `CommandContext.runtime` (`commands-context.ts`), and built fresh per context
  by `public-api/test-support.ts`. It owns only `diffStats: DiffStatsTracking`
  (`diff-stats-tracking.ts`), which replaced the diff-stats `let`s, the
  Git-freshness singletons and the lazy `commands-files` imports. The backend's
  `shutdown()` in `core/index.ts` calls `this.runtime.shutdown()`.
- `commands-runtime-state.ts` is 530 lines and exports 46 mutable bindings: 40
  `Map`/`Set` instances and 6 `let`s.

  | Cluster | Bindings | Production consumers |
  | --- | --- | --- |
  | Terminals (19) | 17 maps and sets from `terminalProcesses` to `terminalActivityCompletionStates`, plus the `let`s `nextTerminalActivityGeneration` and `terminalOutputRetentionMs` | `commands-terminal`, `commands-registry-terminal`, `commands-environment`, `commands-registry-environments`, `commands-registry-teardown` |
  | Local servers (18) | `localServerProcesses`, `localServerWorkingDirectories`, six per-agent bridge token and password maps (`localCodexBridgeTokens`, `localClaudeBridgeTokens`, `localOpenCodeServerPasswords`, `localCursorBridgeTokens`, `localGrokBridgeTokens`, `localPiBridgeTokens`), `localCursorCredentialFingerprints`, `openCodeAgentToolsConfigurations`, `configuredOpenCodeAgentTools`, `localServerEnvironmentOperations`, `containerBridgeOperations`, `localServerUnresponsiveSince`, plus the `let`s `localServerShutdownRequested`, `localServerShutdownPromise`, `terminateProcessTreeImpl`, `spawnLocalServerCommandImpl` | `commands-servers`, `commands-local-server-lifecycle`, `host-model-catalog-refresh`, `pi-model-catalog-seeding`, `agent-accounts-active`, `environment-move` |
  | Environment operations (9) | `environmentSetupSessions`, `environmentSetupTasks`, `environmentSetupStartTasks`, `environmentStartTasks`, `environmentLifecycleOperations`, `environmentBaselineTasks`, `deletingLocalServerEnvironments`, `mergingEnvironments`, `mergeCleanupRecoveryTasks` | `commands-environment`, `commands-servers`, `commands-registry-environments`, `environment-move`, `docker-cleanup-inventory`, `docker-cleanup-preview`, `commands-review`, `commands-terminal`, `commands-local-server-lifecycle` |

  `commands-testing.ts` (the `__testing` helpers) also reaches all three
  clusters.
- Six setter seams remain: `setLocalServerShutdownRequested`,
  `setLocalServerShutdownPromise`, `setTerminateProcessTreeImplementation`,
  `setSpawnLocalServerCommandImplementation`, `setTerminalOutputRetentionMs`
  and `resetTerminalOutputRetentionMs`. Tests reach them through
  `commands-testing.ts`, `commands-registry-terminal.test.ts`,
  `environment-move.test.ts`, `host-model-catalog-refresh.test.ts` and
  `pi-model-catalog-seeding.test.ts`. Two are also production writers, because
  an importer cannot assign an exported `let`: `commands-servers.ts` sets and
  clears the shutdown promise, and `resetTerminalOutputBuffers` in
  `commands-terminal.ts` resets the retention.
- The rest of the file is stateless: about 45 constants (`LOCAL_SERVER_*`,
  `CONTAINER_*`, `HOST_CLAUDE_KEYCHAIN_SERVICE`,
  `AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV`, the OpenCode GitHub plugin source
  and fingerprints, the setup OSC sequences, `TERMINAL_OUTPUT_RETENTION_MS`,
  …) and helpers such as `buildOpenCodeGitHubEnvironmentPluginSource`,
  `withContainerRuntimeCredential`, `shellPrintfSentinel`,
  `buildContainerSafeBase64Reader`, `retryableBridgeStartupError` and
  `localServerStopCommandName`.
- 26 production files import it, plus a doc comment in `backend-runtime.ts`,
  and 12 test files. Those include `commands-runtime-state-load-order.test.ts`,
  which exists only for this module.
- `.oxlintrc.json` still lists it on the `import/no-mutable-exports` allowlist
  (49 entries in all), together with `commands-servers.ts`,
  `commands-files.ts`, `commands-agent-support.ts` and
  `commands-container-exec.ts`.
- `agent-account-bridge-state.ts` holds four more per-bridge maps
  (`localAgentAccountIds`, `localAgentAccountTokenExpiry`,
  `staleLoginLocalBridges`, `staleLoginEnvironmentIds`). They are outside this
  file and invisible to `no-mutable-exports`, because they are `export const`.
- Precedent: `EnvironmentLifecycleTaskTracker`
  (`environment-lifecycle-tasks.ts`) is already a class with private state,
  created in `index.ts`, passed as `CommandContext.environmentLifecycleTasks`
  and reached only through `admit()` and `shutdown()`.

## Outstanding work

### Code

Each step is one PR and must not change behaviour. Re-run the inventory first:
`git grep -n "commands-runtime-state" apps/backend tests` and the binding list
in the file.

1. **`TerminalRuntime`.** Move the 19 terminal bindings into a class on
   `BackendRuntime`, with output retention as a constructor option.
   `commands-registry-terminal.test.ts` builds a runtime instead of calling
   `setTerminalOutputRetentionMs`.
2. **`LocalServerRuntime`.** Move the 18 local-server bindings, with spawn and
   terminate as constructor options and shutdown state private. This is the
   largest step: six consumer modules plus `commands-testing.ts`, and the tests
   that set shutdown state. Where a consumer has no context in reach
   (`host-model-catalog-refresh`, `pi-model-catalog-seeding`,
   `agent-accounts-active`), pass the narrow `LocalServerRuntime` down the call
   chain rather than the whole context. Decide in this step whether it also
   owns the four `agent-account-bridge-state.ts` maps.
3. **`EnvironmentOperations`.** Move the 9 environment-operation bindings.
   Consider folding them into `EnvironmentLifecycleTaskTracker`, which tracks
   the same lifecycle; decide once the two are side by side.
4. **Delete the module.** Move the stateless constants and helpers next to
   their users, delete `commands-runtime-state.ts` and
   `commands-runtime-state-load-order.test.ts`, and remove the module from the
   `import/no-mutable-exports` allowlist. Check with the rule on whether
   `commands-servers.ts`, `commands-files.ts`, `commands-agent-support.ts` and
   `commands-container-exec.ts` still need their entries.
5. **Two-backend test.** Build two `BackendRuntime`s in one process and show
   that a terminal or local server registered in one is invisible to the
   other.
6. **Sibling dynamic imports.** Check whether the remaining `await import()`
   calls of sibling modules exist only to dodge a cycle: the
   `cursor_sdk_login_*` and `cursor_sdk_logout` handlers in
   `commands-registry-projects.ts`, and `defaultRunners` in
   `cursor-sdk-bridge.ts`. `import/no-cycle` does not see dynamic imports.

Done when:

- `commands-runtime-state.ts` no longer exists, and no `set*`/`reset*` seams
  for backend state remain;
- `CommandContext.runtime` is the only path to terminal, local-server,
  environment-operation and diff-stats state;
- the two-backend test exists;
- the allowlist has shrunk by at least `commands-runtime-state.ts`, and
  `mise run lint` is clean;
- no production code calls `await import()` on a sibling backend module just
  to avoid a cycle.

### Qualification

- Every step runs `mise run format:check`, `mise run lint`,
  `mise run typecheck` and `mise run test`.
- Steps 1 and 2 also run `mise run test:agent:browser:isolated`, because
  terminals and local servers are visible end to end.

## Constraints and rationale

- Never destructure the runtime at module load (for example
  `const { terminals } = someRuntime` at module scope). That recreates the
  value-capture bug #417 caused, where an `Object.assign` snapshot froze `let`
  exports. Always reach the runtime through the context at call time.
- One class per cluster, each owning its maps privately. Callers use methods
  named for what they do (`terminals.recordOutput(id, chunk)`,
  `localServers.isShuttingDown()`), not `.get()`/`.set()` on a shared map. A
  read-only accessor is fine where a method would only wrap one map operation.
- Timers belong to their owner and are cleared by that cluster's
  `shutdown()`. Tests should find no live timers after teardown.
- Keep identity semantics. Where two clusters read one map (for example
  `terminalProcesses` from `commands-environment`), give the owning cluster a
  query method rather than sharing the map object.
- Backend shutdown calls `runtime.shutdown()` exactly once, after the gateway
  stops accepting commands. On SIGINT and SIGTERM, `main.ts` runs
  `createBackendShutdownHandler` (`apps/backend/src/shutdown.ts`), which stops
  the gateway and then calls the backend's `shutdown()`; local servers must be
  reached through that path, not through module state.
- This lands before the `commands` slice of
  [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md).
- Out of scope: the other modules on the `no-mutable-exports` allowlist,
  including the bridges' session-manager state. The Claude and Codex bridges
  held 434 exported mutable bindings between them when last counted (245 and
  189); they need their own inventory before anyone picks them up.

## Related

- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md).
- [`linting.md`](../../development/linting.md) ("Module boundaries",
  `import/no-mutable-exports`).

## Replaces

- `docs/2026-10-14/runtime-state-ownership.md`
