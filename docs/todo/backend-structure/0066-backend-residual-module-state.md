# Backend residual module state

Checked against `main` at `8454d18b` plus the 0011 branch (2026-10-24). Done
on `todo-0066-residual-module-state-40e8f98a7ef0` from `20f6de91`
(2026-10-25). Every item below is done. The durable description now lives in
[`backend-runtime.md`](../../architecture/backend-runtime.md); further module
state found while doing this was moved by todo 0133 (finished and deleted)
and its residue is listed in
[0390-backend-module-state-beyond-0133.md](0390-backend-module-state-beyond-0133.md).
Delete this file and its index row once the branch has merged (decision 10).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Retire this finished file**: all seven moves, the allowlist change and the two-backend tests are done and merged (#1253); only the file's own retirement remains. Status: done.

### 1. Retire this finished file

**Problem.** The file is marked Finished and says to delete it with its index row once the branch merged (decision 10). It still holds rank 6 in the folder index, and `docs/README.md:38` links to it from the `backend-runtime.md` row as the place residue is tracked, although the open residue is now in 0133.

**Context.** Follow-up from [0011](0011-backend-runtime-state-ownership.md); further module state was moved by 0133 (finished and deleted); residue is in [0390](0390-backend-module-state-beyond-0133.md). README rule: move durable behaviour into `architecture/`, delete the file, remove the row.

**Investigation.** The branch merged as `f5e5c9a1` (#1253). The claims hold at HEAD: `BackendRuntime` owns `prMonitor` and `containerStates` (`apps/backend/src/core/backend-runtime.ts:39`, `:41`), `backend-runtime.test.ts` has the five new cases (`:177`, `:213`, `:239`, `:272`, `:303`), and neither `commands-container-exec.ts` nor `commands-pr-monitor.ts` is on the `import/no-mutable-exports` allowlist in `.oxlintrc.json`. `docs/architecture/backend-runtime.md` already describes every owner (`terminals.history`, `environments.fence`, `localServers.openCodeHostStart` and `piCatalog`, `prMonitor` with merge cleanup as a construction option, `containerStates`), the construction-option seams and the shutdown order of decision 6 (history timers cleared at `runtime.shutdown()`, collectors kept for the later awaited flush). Two reasons are not in it: decision 5 (the PR monitor's pool is created lazily because the process-wide diagnostics registry caps sources at 32) and decision 4 (it binds the latest caller's storage and emit). Both are the kind of detail a later change would undo by mistake.

**Decisions.**

- **What to do with this file now that its branch has merged?**
  - **Delete it now, after adding decisions 4 and 5 to `backend-runtime.md` (recommended).** One sentence each in the `prMonitor` row or a note under the table; change `docs/README.md:38` to point at 0133 as the residue file; repoint 0011/0133 links; remove the index row.
    - Pros: follows the README rule; the README stops pointing at a finished file for open work; the two non-obvious choices survive.
    - Cons: the validation evidence (the 22 regressions found in the first full run) is only in git history.
  - **Delete it as it stands.**
    - Pros: smallest change.
    - Cons: the lazy-pool reason is lost, and someone hitting the 32-source cap in tests would have to rediscover it.
  - **Keep it until 0133 is done.**
    - Pros: 0133 is its direct continuation and links back for the pattern.
    - Cons: contradicts the README rule; `backend-runtime.md` already documents the pattern 0133 needs.

[0011-backend-runtime-state-ownership.md](0011-backend-runtime-state-ownership.md)
moved everything in `commands-runtime-state.ts` and
`agent-account-bridge-state.ts` into `BackendRuntime` clusters
(`TerminalRuntime`, `LocalServerRuntime`, `EnvironmentOperations`). Its scope
was those two modules. Other backend modules still kept per-process state at
module level, so two backends in one process still shared it. This file listed
that residue so it could be moved the same way.

## Current state

Every row now lives in a per-backend owner reached through `context.runtime`
at call time:

| Module (before) | State | Owner now |
| --- | --- | --- |
| `terminal-account-usage.ts` (deleted) | `terminalAccountHomes` | `TerminalRuntime` private `accountHomes` behind `recordAccountHome`, `forgetAccountHome`, `isAccountHomeInUse` (and read-only `accountHome`); `cleanupSession` still prunes it |
| `terminal-history.ts` | `sessions`, `sessionConfigurations`, `historyIoTails`, `historyDisposals`, root-prune tails, counters, page-read concurrency, the four retention values, the directory cap, two test hooks | `TerminalHistory` class, owned as `runtime.terminals.history`; hooks and the directory cap are `terminals.history` construction options |
| `environment-replacement-fence.ts` | the seven Maps/Sets | `EnvironmentMutationFence`, owned as `runtime.environments.fence` |
| `opencode-host-start.ts` | `hostStartTail`, `lockedStartRetryDelaysMs` | `OpenCodeHostStartGate`, owned as `runtime.localServers.openCodeHostStart`; delays are `localServers.openCodeLockedStartRetryDelaysMs` |
| `pi-model-catalog-seeding.ts` | `piCatalogDiscovery`, `piCatalogForcedDiscovery`, `piCatalogEmptyProbeAt`, `piCatalogProbeSequence` | `PiCatalogProbes` (`pi-catalog-probes.ts`), owned as `runtime.localServers.piCatalog`; the clock is `localServers.piCatalog.now` |
| `commands-container-exec.ts` | `export let dockerContainerStateCache` | `DockerContainerStateCache` (`docker-container-state-cache.ts`), owned as `runtime.containerStates` |
| `commands-pr-monitor.ts` | five `export let`s, the `prMonitorService` and `prMonitorAdmission` singletons, `mergeCleanupScheduler`, `deferredMergeCleanups` | `PrMonitorRuntime` (`pr-monitor-runtime.ts`), owned as `runtime.prMonitor`; merge cleanup is the construction option `prMonitor.scheduleMergeCleanup` |

`coordinatorResearchLaunches` in `commands-servers.ts` is a `WeakMap` keyed by
the bridge's child process object, so it cannot be shared between backends;
it needed no move.

## Outstanding work

### Code

1. **Done — Move each row into its owner.** See Current state. The removed
   seams: `terminalHistoryTesting` (`clear`, `setPageReadHook`,
   `setSerializeHook`, `setMaxHistoryDirectories`),
   `__testing.resetTerminalHistory`, `__testing.resetOpenCodeHostStart`,
   `__testing.resetDockerContainerStateCache`,
   `setOpenCodeLockedStartRetryDelaysForTests`,
   `resetOpenCodeHostStartForTests`, `resetPiModelCatalogSeedingState`,
   `setDockerContainerStateCache`, `invalidateDockerContainerStateCache`,
   `setMergeCleanupScheduler`, `resetMergeCleanupSchedulerForTesting`,
   `deferredMergeCleanupCountForTesting`, `setPrMonitorRuntime`,
   `requirePrMonitorStorage` and `shutdownPrMonitorTracking`. Tests build the
   runtime (or the class) with options instead. `git grep` for each name in
   `apps tests scripts` finds nothing.
   - Code without a context in reach gets the narrow piece:
     `createEnvironmentCommandRunner(environment, fence)`,
     `NativeAgentService`'s `environmentFence` option (wired from
     `index.ts`), `recoverInterruptedEnvironmentMove(…, fence, …)`, and the
     tmux session keeps the `TerminalRuntime` it recorded its account home in.
     `InteractiveTmuxTerminalManager.write` now takes the command's context.
   - `getOrkestratorContainerStates(context)` now requires a context with a
     runtime; all its callers already passed one.
2. **Done — Allowlist.** `commands-container-exec.ts` and
   `commands-pr-monitor.ts` are off the `import/no-mutable-exports` allowlist
   in `.oxlintrc.json`; `mise run lint` exits 0.
3. **Done — Two-backend test.** `backend-runtime.test.ts` now has eight cases
   (three from 0011). The five new ones prove the replacement and move fence
   (including `create_local_terminal_session` refusing only in the moving
   backend), host OpenCode start turns and retry delays, Pi catalogue backoff
   and probe generations, the container-state snapshot, terminal history and
   terminal account homes, and the PR monitor's service, merge-cleanup
   scheduler and shutdown are each per backend. 8 pass.

### Qualification

Run on this host (macOS, Apple Silicon) on 2026-10-25:

- `mise run format:check`: passed.
- `mise run lint`: exit 0; no findings in changed files.
- `mise run typecheck` (through `test:logged`): passed.
- `mise run test`: see Validation evidence.

## Validation evidence

- Focused runs, mine: the fence, host-start, Pi, container-state and
  two-backend files (`environment-move`, `native-agent-service-prompt`,
  `native-agent-service-replacement-fence`, `commands-registry-terminal`,
  `tmux-commands-interactive`, `tmux-interactive`, `github-cli-operations`,
  `pi-model-catalog-seeding`, `opencode-host-start`,
  `host-model-catalog-refresh`, `backend-core`, `backend-runtime`): 230 pass,
  2 skip, 0 fail.
- Terminal history and account homes (14 files including `terminal-history`,
  `agent-accounts`, `terminal-runtime`, `commands-registry-terminal`,
  `tmux-session`, `commands-registry-projects`, `storage-config-inherited`):
  passed. A full backend run on that branch found one real regression,
  `storage-config-inherited.test.ts` building a context without a runtime,
  now fixed; its other failures were `standalone.test.ts` needing a built
  `dist/main.js` (passes after `bun run --cwd apps/backend build`) and a
  `docker-image.test.ts` timeout under load that passes alone.
- PR monitor: `tests/unit/merge-cleanup-scheduler.test.ts` and
  `module-import-cycles.test.ts` (7 pass); 71 backend files that touch the
  fixtures, the PR monitor or `BackendRuntime` passed through `test:logged`
  (101 s); `src/core/public-api` and the container lifecycle, readiness and
  diff-stats files passed.
- `mise run test`, first run on the merged branch: backend 22 failures, all
  real regressions of this work: hand-built contexts without a `runtime` in
  `review-validation-service.test.ts` (3), `commands-registry-design.test.ts`
  (9), `commands-review.test.ts` (9) and
  `design/session-links-commands.test.ts` (1), reaching the fence through
  `controlReviewValidation`, the design registry wrapper and
  `createEnvironmentCommandRunner`. Fixed by giving those contexts a runtime;
  the four files then passed (39 tests). The other two failures were flakes
  in code this branch does not touch: the desktop fixture tree digest timeout
  (existing case 0258; the owner passed alone, 48 pass) and a cursor-bridge
  steer hook timeout (new case 0855; the owner passed alone, 21 pass).
- `mise run test`, final run on `cddad46c`: web (9,670 tests), desktop,
  bridges, codex protocol lockfile, CLI, protocol and toolchain passed.
  Backend: 11,048 tests, 10,963 pass, 84 skip, 1 fail, the agent-mail backlog
  timeout (existing case 0661; owner passed alone, 50 pass). Root: 3,415
  tests, 3,414 pass, 1 fail,
  `runOpenCodeLiveCompatibility > kills the server when the overall deadline expires`
  (case 0166, reopened; owner passed alone, 31 pass). Neither failure is in
  code this branch changed.
- Scenario suites (`test:agent:browser:isolated`, `test:agent:docker`,
  `test:agent:electron`) were not run: the change is backend-internal state
  ownership with no renderer, Electron or Docker lifecycle behaviour change,
  and production runs one backend per process, so behaviour there is
  unchanged.

## Assumptions and decisions

1. **One branch for all seven moves.**
   - Options: one PR per row ("one owner at a time"); one branch for all.
   - Chosen: one branch, as the task asked. The moves were done in three
     parallel streams (terminal history and account homes; PR monitor; the
     other four) and merged.
   - Pros: one review, no intermediate state with half the residue global,
     one `backend-runtime.test.ts` change. Cons: a large diff (about 70 code
     files) that is harder to bisect inside.
2. **Owners: sub-objects of existing clusters where they share a lifetime,
   new runtime properties otherwise.**
   - Options: one new class per row on `BackendRuntime`; fold every map into
     the named cluster class; sub-objects.
   - Chosen: `terminals.history`, `environments.fence`,
     `localServers.openCodeHostStart` and `localServers.piCatalog` as
     sub-objects of the clusters the file named; `prMonitor` and
     `containerStates` as new `BackendRuntime` properties (the file asked for
     their own classes).
   - Why: each piece is self-contained (terminal history alone is 1,675 lines)
     and would dominate its cluster if folded in; making it a sub-object keeps
     the owner the file named and the cluster small.
   - Pros: each class is small and private; `TerminalRuntime`,
     `EnvironmentOperations` and `LocalServerRuntime` barely grew. Cons: one
     more hop (`context.runtime.environments.fence.beginMutation(...)`).
3. **Merge cleanup is a construction option, not a registration.**
   - Options: keep the module-level `setMergeCleanupScheduler` registration
     and its deferred map; register per runtime; pass it at construction.
   - Chosen: `new BackendRuntime({ prMonitor: { scheduleMergeCleanup } })`,
     passed by `index.ts` and `tests/command-fixtures.ts`. Without it a merged
     observation's cleanup is skipped with one warning per runtime.
   - Why: a module registration is shared by every backend, and the deferral
     window it needed (before `commands-servers` loaded) does not exist once
     the backend wires it at construction. `backend-runtime.ts` still does not
     import `commands-servers.ts`, and `KNOWN_CYCLES` stays empty.
   - Pros: no module state, no load-order window, per-backend scheduler.
     Cons: a runtime built without the option (some light fixtures) skips
     merge cleanup; production always passes it, and the durable cleanup
     intent is resumed by `get_environments` anyway.
4. **The PR monitor binds the latest caller's storage and emit, as before.**
   - Options: the runtime's own `emit`; the bound context's.
   - Chosen: the bound context's.
   - Why: identical in production; several tests capture events through the
     context while the runtime has a no-op emit.
   - Pros: no observable change. Cons: still a "latest caller" binding inside
     the runtime rather than a constructor dependency.
5. **The PR monitor's service and `external-pr` pool are created on first
   use.**
   - Options: create them eagerly in the constructor; lazily.
   - Chosen: lazily, discarded and closed on `shutdown()`.
   - Why: each `WorkAdmissionPool` registers in a process-wide diagnostics
     registry capped at 32 sources, and most test runtimes never touch the PR
     monitor.
   - Pros: no registry exhaustion in tests. Cons: the `gh` concurrency bound
     is now per backend instead of per process; production has one backend per
     process, so the bound is unchanged there.
6. **Shutdown order is unchanged.**
   - PR monitor: `shutdownPrMonitorTracking()` ran immediately after
     `runtime.shutdown()` in `index.ts`; it now runs as the last step of
     `runtime.shutdown()`.
   - Terminal history: `runtime.shutdown()` clears history timers (flush,
     checkpoint, prune continuation) but keeps collectors usable, because the
     backend's awaited `terminals.history.flush(true)` runs later, after the
     lifecycle drain, as `flushTerminalHistories(true)` did. Disposing
     collectors at `shutdown()` (what the old test-only `clear()` did) was
     rejected: the final flush would then skip their last checkpoint.
7. **Test clocks and tuning become options.**
   - The Pi "probes again once the backoff is cleared" test reset module state;
     it now advances an injected clock (`localServers.piCatalog.now`) past
     `PI_CATALOG_EMPTY_PROBE_BACKOFF_MS`, which tests the real backoff edge.
   - The OpenCode host-start test sets
     `localServers.openCodeLockedStartRetryDelaysMs: [20, 20]` on its runtime.
   - Terminal history tests build `new TerminalHistory(options)` directly and
     simulate a backend restart by building a second one.
8. **The tmux test harness supplies one runtime per test.**
   - Options: add a runtime to each of the 22 hand-built contexts; a harness
     default.
   - Chosen: `invoke` in `tests/tmux-test-harness.ts` adds the current
     per-test runtime (`harnessRuntime()`) when the context names none; it is
     shut down and replaced in `afterEach`.
   - Pros: small diff; fence state cannot leak between tests. Cons: a test
     that wants two backends must still pass its own runtime.
9. **Further module state goes to a new todo, 0133, rated Low.**
   - Options: widen this branch; leave it unrecorded; record it.
   - Chosen: record it in 0133, since finished and deleted (tmux sessions and interactive terminals, account usage stores,
     public-API in-flight maps, OOM watcher, GitHub/Linear locks, and the
     host-wide Docker caches that may legitimately stay process-wide).
   - Why: this file's scope was its seven rows; the README forbids adding new
     items to an existing file.
10. **This file is kept until the branch merges.**
    - Options: delete it now (README rule for finished files); keep it with
      Finished: Yes until merge.
    - Chosen: keep it, as 0010, 0011 and 0013 do, so the review sees the
      decisions and evidence; the durable description is in
      `backend-runtime.md`.

## Constraints and rationale

The same as 0011: one class per owner with private state, reached through
`context.runtime` at call time, never destructured at module load; timers are
cleared by the owner's `shutdown()`.

## Related

- [0011-backend-runtime-state-ownership.md](0011-backend-runtime-state-ownership.md)
- [0390-backend-module-state-beyond-0133.md](0390-backend-module-state-beyond-0133.md)
- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md)
- [`backend-runtime.md`](../../architecture/backend-runtime.md)
