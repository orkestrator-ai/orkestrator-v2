# Backend module state beyond 0066

Found while doing
[0066-backend-residual-module-state.md](0066-backend-residual-module-state.md)
on `main` at `20f6de91` (2026-10-25). 0066 moved the seven modules it listed
into `BackendRuntime`. A scan of `apps/backend/src` for module-level `let`s
and `Map`/`Set`/service singletons found more per-process state that 0066 did
not list. Two backends in one process still share it. 0066 could not take new
items (README rule), so it is recorded here.

## Current state

Per-backend state: work, sessions or caches that belong to one backend and
should follow the 0011/0066 pattern.

| Module | State | Likely owner |
| --- | --- | --- |
| `tmux-session-manager.ts` | `tmuxManager` (`TmuxSessionManager`), `tmuxActivityWrites`, `orphanedTmuxMissingSince`, `export let lastTmuxOrphanSweepAt` (on the `import/no-mutable-exports` allowlist), and the registered `localClaudeConfigDirectory` provider | `TerminalRuntime`, or a tmux class on `BackendRuntime` |
| `tmux-interactive.ts` | `interactiveTerminals` (`InteractiveTmuxTerminalManager`, with timers) | the same tmux owner |
| `tmux-poll.ts` | `defaultClaudeStatePolls` (`ClaudeStatePollManager`) | the same tmux owner |
| `feature-build.ts` | `pendingTaskResolutions`, `pendingFeatureTitleRefinements` | `EnvironmentOperations` or a build class |
| `public-api/run-observer.ts`, `public-api/actions-exec.ts` | `inFlight` reconciliation maps | a public-API class on `BackendRuntime` |
| `docker-cleanup-preview.ts` | `grants` (preview grants) | a Docker-cleanup class on `BackendRuntime` |
| `cursor-sdk-bridge.ts` | `activeLogin`, `activeLoginStartup` | `LocalServerRuntime` |
| `agent-accounts-last-usage.ts` | `loaded`, `writes`, `dirty` | an accounts class on `BackendRuntime` |
| `agent-accounts-active.ts` | registered `localClaudeLoginRefresher`, `localCodexLoginRefresher`, `clearedCoordinatorKeychainEntries` | the same accounts owner |
| `container-oom-events.ts` | `watcher` (`OomEventWatcher`) | `BackendRuntime` (started and stopped with the backend) |
| `commands-validation.ts`, `github.ts` | completion-comment and label/issue-status lock maps | a GitHub/Linear class on `BackendRuntime` |
| `environment-cleanup.ts` | `loggedKeptBranches` (log de-duplication) | low value; may stay |

Host-wide caches: they describe the machine or Docker daemon, not one backend,
so sharing them between two backends in a process is arguably correct. Decide
per entry whether to move or document them as intentionally process-wide.

| Module | State |
| --- | --- |
| `container-resources.ts` | `capacityCache`, `diskCache`, `usageCache`, `inflight` |
| `docker-image.ts` | `manifestCache`, `topologyCache` |
| `git-docker-scan-pool.ts` | `gitDockerScanPool` (`WorkAdmissionPool`) |
| `change-tracking/environment-projector.ts`, `change-tracking/legacy-payload.ts` | `gitVersionPromise`, `compatibilityCache` |
| `design/export-writer.ts` | `destinationLocks`, `destinationOperations` |
| `gateway-support-core.ts` | `export let activeDynamicCompressions` (gateway, not core) |

`public-api/reconciler.ts` (`reconcilers`) is a registry of functions filled
at module load, the same for every backend; it is code wiring, not state.

## Outstanding work

### Code

1. Decide, per host-wide cache above, whether it moves or stays; record the
   choice next to the state.
2. Move each per-backend row into its owner behind methods, with no
   `set*`/`reset*` seams; tests construct the runtime with options instead.
   The tmux rows go together (they share sessions and timers).
3. Take `tmux-session-manager.ts` off the `import/no-mutable-exports`
   allowlist once `lastTmuxOrphanSweepAt` is gone.
4. Extend `backend-runtime.test.ts` so the two-backend test covers each moved
   piece.

### Qualification

- `mise run format:check`, `mise run lint`, `mise run typecheck`,
  `mise run test` for each move.

## Constraints and rationale

The same as 0011 and 0066: one class per owner with private state, reached
through `context.runtime` at call time, never destructured at module load;
timers are cleared by the owner's `shutdown()`. Production runs one backend
per process, so none of this changes shipped behaviour.

## Related

- [0066-backend-residual-module-state.md](0066-backend-residual-module-state.md)
- [0011-backend-runtime-state-ownership.md](0011-backend-runtime-state-ownership.md)
- [`backend-runtime.md`](../../architecture/backend-runtime.md)
