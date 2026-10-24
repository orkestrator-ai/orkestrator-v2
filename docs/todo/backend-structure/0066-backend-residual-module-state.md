# Backend residual module state

Checked against `main` at `8454d18b` plus the 0011 branch (2026-10-24).

[0011-backend-runtime-state-ownership.md](0011-backend-runtime-state-ownership.md)
moved everything in `commands-runtime-state.ts` and
`agent-account-bridge-state.ts` into `BackendRuntime` clusters
(`TerminalRuntime`, `LocalServerRuntime`, `EnvironmentOperations`). Its scope
was those two modules. Other backend modules still keep per-process state at
module level, so two backends in one process still share it. This file lists
that residue so it can be moved the same way, one owner at a time.

## Current state

| Module | State | Owner it belongs with |
| --- | --- | --- |
| `terminal-account-usage.ts` | `terminalAccountHomes` (`export const` Map; written by `start_local_terminal_session`, pruned by `TerminalRuntime.cleanupSession`, read by `removeAgentAccount`) | `TerminalRuntime` |
| `terminal-history.ts` | `sessions`, `sessionConfigurations`, `historyIoTails`, `historyDisposals` Maps and four retention `let`s; tests reset it through `terminalHistoryTesting.clear()` (`__testing.resetTerminalHistory`) | `TerminalRuntime`, or its own class on `BackendRuntime` |
| `environment-replacement-fence.ts` | seven Maps/Sets (`replacingEnvironments`, `movingEnvironments`, `recoveryPending`, `pendingMutations`, `movingPaths`, `pendingPathWrites`, `pendingAgentWork`) | `EnvironmentOperations` |
| `opencode-host-start.ts` | `hostStartTail`, `lockedStartRetryDelaysMs`; tests reset it through `resetOpenCodeHostStartForTests` | `LocalServerRuntime` |
| `pi-model-catalog-seeding.ts` | `piCatalogDiscovery`, `piCatalogForcedDiscovery`, `piCatalogEmptyProbeAt`, `piCatalogProbeSequence` | `LocalServerRuntime` or a catalogue cache on `BackendRuntime` |
| `commands-container-exec.ts` | `export let dockerContainerStateCache` (on the `import/no-mutable-exports` allowlist) | a container-state class on `BackendRuntime` |
| `commands-pr-monitor.ts` | five `export let`s (`prMonitorEmit`, `prMonitorStorage`, `prMonitorContext`, `prMonitorSyncGeneration`, `prMonitorSyncQueue`), `mergeCleanupScheduler`, `deferredMergeCleanups` (on the allowlist) | a PR-monitor class on `BackendRuntime` |

`coordinatorResearchLaunches` in `commands-servers.ts` is a `WeakMap` keyed by
the bridge's child process object, so it cannot be shared between backends;
it needs no move.

## Outstanding work

### Code

1. Move each row into the named owner, behind methods, with no `set*`/`reset*`
   seams; tests construct the runtime with options instead.
2. Take `commands-container-exec.ts` and `commands-pr-monitor.ts` off the
   `import/no-mutable-exports` allowlist once their `export let`s are gone.
3. Extend `backend-runtime.test.ts` so the two-backend test covers each moved
   piece.

### Qualification

- `mise run format:check`, `mise run lint`, `mise run typecheck`,
  `mise run test` for each move.

## Constraints and rationale

The same as 0011: one class per owner with private state, reached through
`context.runtime` at call time, never destructured at module load; timers are
cleared by the owner's `shutdown()`.

## Related

- [0011-backend-runtime-state-ownership.md](0011-backend-runtime-state-ownership.md)
- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md)
