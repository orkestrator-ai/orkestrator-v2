# Backend module state beyond 0066

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Decide the host-wide caches**: move or document as process-wide, per entry. Status: open.
2. **Move the tmux state into one owner**: `tmuxManager`, activity writes, orphan tracking, interactive terminals, Claude state polls and the registered config-directory provider. Status: open.
3. **Move the other per-backend rows**: feature build, public-API in-flight maps, cleanup preview grants, Cursor SDK login, account usage and refreshers, the OOM watcher, GitHub/Linear locks, the kept-branch log set. Status: open.
4. **Take `tmux-session-manager.ts` off the `import/no-mutable-exports` allowlist**. Status: open.
5. **Two-backend tests and qualification**: extend `backend-runtime.test.ts` per moved piece; format, lint, typecheck and `mise run test` per move. Status: open.

### 1. Decide the host-wide caches

**Problem.** Six modules keep caches that describe the host or the Docker daemon. Nobody has recorded whether they are meant to be shared between backends in one process, so the next contributor cannot tell an intentional process-wide cache from leftover module state.

**Context.** Found while doing [0066](0066-backend-residual-module-state.md). Production runs one backend per process; the cost of sharing is only test isolation.

**Investigation.** All entries are still present: `container-resources.ts:154`, `:155`, `:325`, `:326` (capacity, disk, usage, in-flight); `docker-image.ts:110` and `:345` (manifest and topology); `git-docker-scan-pool.ts:12` (`gitDockerScanPool`); `change-tracking/environment-projector.ts:39` (`gitVersionPromise`); `change-tracking/legacy-payload.ts:154` (`compatibilityCache`); `design/export-writer.ts:269` and `:270`; and `apps/backend/src/gateway-support-core.ts:1658` (`export let activeDynamicCompressions`, the file path in the table should read `src/`, not `core/`). Their tests reset them through module setters: `resetResourceCaches` (7 test files), `resetDockerTopologyCache` (7), `resetImageManifestCache` (5), which are exactly the `reset*` seams the 0011/0066 pattern removes. `gitDockerScanPool` is a host-wide concurrency bound, so splitting it per backend would double the bound if two backends ever shared a host.

**Decisions.**

- **What to do with each host-wide cache?**
  - **Keep the Docker, Git-version and scan-pool caches process-wide and document that at each declaration; move `activeDynamicCompressions` and the design export locks (recommended).** The Docker and Git caches describe the machine, and the pool bounds the host; the compression counter bounds one gateway's CPU and the export locks order one backend's writes.
    - Pros: matches what the state means; the comment answers the question for the next reader; removes the gateway's `export let` (one more allowlist entry).
    - Cons: the `reset*` test seams stay for the kept caches, which the pattern otherwise forbids.
  - **Move every entry onto `BackendRuntime`.**
    - Pros: no module state left, no `reset*` seams; tests build a runtime instead.
    - Cons: two backends would each run their own `docker system df` and manifest reads, and the scan pool's host bound would no longer hold.
  - **Document all six as process-wide and move nothing.**
    - Pros: smallest change.
    - Cons: keeps the gateway's mutable export on the allowlist and the export-lock map shared, though both are per backend in meaning.

### 2. Move the tmux state into one owner

**Problem.** Tmux sessions, interactive terminals and Claude state polls are module singletons, so two backends in one process share terminal sessions and timers.

**Context.** The file says the tmux rows go together because they share sessions and timers, owned by `TerminalRuntime` or a tmux class on `BackendRuntime`.

**Investigation.** Still module state: `tmux-session-manager.ts:1535` to `:1538` (`tmuxManager`, `tmuxActivityWrites`, `orphanedTmuxMissingSince`, `export let lastTmuxOrphanSweepAt`), the config-directory provider at `:71` set by `setLocalClaudeConfigDirectoryProvider` (`:73`, called at module load from `commands-servers.ts:1629`), `tmux-interactive.ts:307` (`interactiveTerminals`) and `tmux-poll.ts:703` (`defaultClaudeStatePolls`). `tmuxManager` is imported by four production files (including `index.ts:146` and `environment-move.ts:27`), and `setLastTmuxOrphanSweepAt` is used by `tmux-commands.ts:498` and one test. `tmux-session-manager.ts` is 1,739 lines, so a new owner class must not push it over the limit.

**Decisions.**

- **Where should the tmux state live?**
  - **A new `TmuxRuntime` on `BackendRuntime`, holding the session manager, interactive terminals and state polls (recommended).**
    - Pros: one owner for state that shares sessions and timers; `TerminalRuntime` (PTYs) stays small, as decision 2 of 0066 preferred for self-contained pieces; one `shutdown()` clears all tmux timers.
    - Cons: a new runtime property and another hop (`context.runtime.tmux`).
  - **A `tmux` sub-object of `TerminalRuntime`.**
    - Pros: terminals and tmux are one user concept; matches `terminals.history`.
    - Cons: the tmux code is Claude-terminal-mode specific and large; folding it under the PTY cluster makes that cluster the biggest one.
- **How does the config-directory provider get wired?**
  - **A `BackendRuntime` construction option passed from `index.ts`, as `prMonitor.scheduleMergeCleanup` was (recommended).**
    - Pros: removes a module-load registration in `commands-servers.ts`; follows the documented rule in `backend-runtime.md`.
    - Cons: fixtures that use tmux must pass it, or get the current "no directory" default.
  - **Keep the module registration.**
    - Pros: no fixture changes.
    - Cons: a module-load side effect shared by every backend, the pattern this work removes.

### 3. Move the other per-backend rows

**Problem.** Several services keep per-backend work in module maps, so a second backend in the same process sees, or clobbers, the first's state.

**Context.** Rows listed in the file's first table, each with a suggested owner.

**Investigation.** All still present: `feature-build.ts:50`, `:51`; `public-api/run-observer.ts:56` and `public-api/actions-exec.ts:46` (`inFlight`); `docker-cleanup-preview.ts:52` (`grants`, already scoped by an `owner` field on each grant, with a `resetCleanupGrants` test seam at `:66`); `cursor-sdk-bridge.ts:303`, `:311`; `agent-accounts-last-usage.ts:25` to `:27` with `resetAgentAccountLastUsageForTests` (`:136`); `agent-accounts-active.ts:285`, `:334`, `:483`; `container-oom-events.ts:130`; `commands-validation.ts:263`, `:264` (exported lock maps); `github.ts:121`, `:122`; `environment-cleanup.ts:477`. Two rows show concrete cross-backend interference, not just sharing: `startOomEventWatcher(owner)` (`container-oom-events.ts:133`) is idempotent, so a second backend's owner is silently ignored and the first backend's `shutdownOomEventWatcher()` (`core/index.ts:2129`) stops the watcher for both; and `index.ts:1415`/`:1420` register the Claude and Codex login refreshers last-writer-wins, while `index.ts:2125`/`:2126` clear them on shutdown, so stopping one backend disables the other's refresh. Both matter only with two backends in one process.

**Decisions.**

- **In what order should the rows move?**
  - **OOM watcher and login refreshers first, then the rest in one or two changes (recommended).**
    - Pros: those two have real start/stop interference in multi-backend tests; they also map cleanly to `BackendRuntime` start and shutdown.
    - Cons: the remaining rows wait.
  - **All rows in one branch, as 0066 did.**
    - Pros: one review and one `backend-runtime.test.ts` change; no half-moved state.
    - Cons: a wide diff touching accounts, public API, GitHub and Docker cleanup at once.
- **Should `loggedKeptBranches` and the cleanup preview grants move at all?**
  - **Leave both, with a comment saying why (recommended).** The log set only de-duplicates log lines; grants already carry their owner.
    - Pros: no churn for state whose sharing is harmless.
    - Cons: two module-level collections remain, and the grant reset seam stays.
  - **Move both for completeness.**
    - Pros: a clean "no module state" rule.
    - Cons: effort without isolation benefit.

### 4. Take `tmux-session-manager.ts` off the allowlist

**Problem.** `tmux-session-manager.ts` is one of ten backend entries still allowed to export mutable bindings.

**Context.** The file ties this to removing `lastTmuxOrphanSweepAt` in task 2.

**Investigation.** The allowlist is the 43-file `import/no-mutable-exports: off` override in `.oxlintrc.json`. `lastTmuxOrphanSweepAt` (`tmux-session-manager.ts:1538`) is the file's only `export let`, and nothing outside the module reads the binding: readers use `getLastTmuxOrphanSweepAt()` (`:1733`) and writers `setLastTmuxOrphanSweepAt()` (`:1737`). Dropping the `export` keyword alone would satisfy the rule.

**Decisions.**

- **Do it now or with task 2?**
  - **Now, as a one-line change: drop the `export` and remove the allowlist entry (recommended).**
    - Pros: independent of the tmux move; closes the item immediately; `mise run lint` proves it.
    - Cons: the setter seam remains until task 2 removes it.
  - **With task 2, as the file planned.**
    - Pros: one change removes both the export and the setter.
    - Cons: a trivial win waits on the largest task in the file.

### 5. Two-backend tests and qualification

**Problem.** Each move needs proof that two backends no longer share the moved state.

**Context.** `backend-runtime.test.ts` has eight cases (three from 0011, five from 0066); the file asks for one per moved piece plus format, lint, typecheck and `mise run test` per move.

**Investigation.** The test file is `apps/backend/src/core/backend-runtime.test.ts` (cases at `:68` to `:303`). The tmux harness already supplies a per-test runtime (`tests/tmux-test-harness.ts`, 0066 decision 8), so tmux tests can adopt a runtime-owned manager without editing every context.

**Decisions.**

- **What counts as a pass for each move?**
  - **A two-backend case showing isolation and independent shutdown, plus removal of the module's `reset*`/`set*` seam (recommended).**
    - Pros: tests the property that matters (the OOM and refresher cases fail today on shutdown, not just on reads); matches 0066's evidence.
    - Cons: more test code per move.
  - **Isolation of reads only.**
    - Pros: simpler cases.
    - Cons: misses the shutdown interference found above.
- **Run `mise run test` per move or once per branch?**
  - **Once per branch, with focused tests per move (recommended).**
    - Pros: the full suite is slow and has known flakes; focused runs catch per-move breakage.
    - Cons: a regression found late has several candidate moves; 0066's first full run found 22 hand-built contexts lacking a runtime.
  - **Per move, as the file says.**
    - Pros: precise attribution.
    - Cons: several full runs for low-rated work.

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
- [0733-two-backends-share-process-watchers.md](0733-two-backends-share-process-watchers.md): the OOM watcher, login refresher and container log service shutdown interference, split out.
