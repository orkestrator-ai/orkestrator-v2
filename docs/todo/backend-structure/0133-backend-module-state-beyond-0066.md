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
on `main` at `20f6de91` (2026-10-25). Done on
`todo-0133-backend-module-state-3cc0d753a9d5` from `863b5782` (2026-10-27).
Every item below is done. The durable description now lives in
[`backend-runtime.md`](../../architecture/backend-runtime.md); further
per-backend module state found while doing this is listed in
[0390-backend-module-state-beyond-0133.md](0390-backend-module-state-beyond-0133.md).
Delete this file and its index row once the branch has merged (decision 12).

0066 moved the seven modules it listed into `BackendRuntime`. A scan of
`apps/backend/src` for module-level `let`s and `Map`/`Set`/service singletons
found more per-process state that 0066 did not list, so two backends in one
process still shared it. This file listed that state so it could be moved the
same way, and the host-wide caches so each could be decided.

## Current state

Per-backend state now lives in an owner reached through `context.runtime` at
call time:

| Module (before) | State | Owner now |
| --- | --- | --- |
| `tmux-session-manager.ts` | `tmuxManager`, `tmuxActivityWrites`, `orphanedTmuxMissingSince`, `export let lastTmuxOrphanSweepAt` and its get/set pair, the registered `localClaudeConfigDirectory` provider | `TmuxRuntime` (`tmux-runtime.ts`), owned as `runtime.tmux`: `sessions` (the `TmuxSessionManager`), `persistEnvironmentActivity`, `beginOrphanSweep`, `orphanFirstSeen`/`forgetOrphan`; the provider is the construction option `tmux.localClaudeConfigDirectory` (`tmuxLocalClaudeConfigDirectory` in `commands-servers.ts`) |
| `tmux-interactive.ts` | `interactiveTerminals`, `detachInteractiveTerminalsForEnvironment` | `runtime.tmux.interactiveTerminals`; `detachAll()` runs at shutdown |
| `tmux-poll.ts` | `defaultClaudeStatePolls` and its module-load diagnostics registration; the registry's `claudeStatePolls`/`claudeStateSignal` options and `setSignalInstaller` | `runtime.tmux.claudeStatePolls`, built from `tmux.claudeStatePolls` options (the backend passes `signal: backendClaudeStateSignal()`); the runtime registers and removes the `claude-state-signal` diagnostics source; `shutdownClaudeStatePolling(context, containerId)` |
| `feature-build.ts` | `pendingTaskResolutions`, `pendingFeatureTitleRefinements`, `waitForPendingFeatureTitleRefinements` | `FeatureBuildTasks` (`feature-build-tasks.ts`), owned as `runtime.featureBuilds`; `FeatureBuildContext` names `runtime.featureBuilds` |
| `public-api/run-observer.ts`, `public-api/actions-exec.ts` | `inFlight` maps | `PublicApiReconciliations` (`public-api/reconciliations.ts`), owned as `runtime.publicApi` |
| `docker-cleanup-preview.ts` | `grants`, `resetCleanupGrants` | `DockerCleanupGrants` (`docker-cleanup-grants.ts`), owned as `runtime.dockerCleanupGrants` |
| `cursor-sdk-bridge.ts` | `activeLogin`, `activeLoginStartup` | `CursorSdkLoginSlot` (`cursor-sdk-login.ts`), owned as `runtime.localServers.cursorSdkLogin`; `cancelCursorSdkLogin(context)` |
| `agent-accounts-last-usage.ts` | `loaded`, `writes`, `dirty`, `resetAgentAccountLastUsageForTests` | `AgentAccountLastUsage`, owned as `runtime.accounts.lastUsage` |
| `agent-accounts-active.ts` (and `agent-accounts-containers.ts`) | `localClaudeLoginRefresher`, `localCodexLoginRefresher`, `clearedCoordinatorKeychainEntries` (and `hostClaudeLoginRefresher`), their `set*` registrations | `AgentAccountsRuntime` (`agent-accounts-runtime.ts`), owned as `runtime.accounts`: the refreshers are construction options; `readCoordinatorCodexLogin` and `prepareCoordinatorCodexHome` take the narrow `accounts` piece |
| `container-oom-events.ts` | `watcher`, `startOomEventWatcher`, `containerOomEvents`, `shutdownOomEventWatcher` | `ContainerOomEvents`, owned as `runtime.containerOom`; stopped by the backend and by `runtime.shutdown()` |
| `commands-validation.ts`, `github.ts` | completion-comment locks, `ensureLabelLocks`, `issueStatusLocks` | `IntegrationLocks` (`integration-locks.ts`), owned as `runtime.integrationLocks`; `ensureGitHubWorkflowLabels`, `listGitHubIssues` and `updateGitHubIssueStatus` take `GitHubWriteLocks` first |
| `container-resources.ts` | `usageCache`, `inflight` (listed as host-wide; see decision 2) | `ContainerUsageSampler` (`container-usage-sampler.ts`), owned as `runtime.containerUsage` |

Host-wide state decided to stay process-wide, each marked next to its
declaration and listed in `backend-runtime.md` ("Process-wide on purpose"):
`container-resources.ts` `capacityCache`/`diskCache`; `docker-image.ts`
`manifestCache`/`topologyCache`; `git-docker-scan-pool.ts`
`gitDockerScanPool`; `change-tracking/environment-projector.ts`
`gitVersionPromise`; `change-tracking/legacy-payload.ts`
`compatibilityCache`; `design/export-writer.ts`
`destinationLocks`/`destinationOperations`; `gateway-support-core.ts`
`activeDynamicCompressions`; `environment-cleanup.ts` `loggedKeptBranches`.
`public-api/reconciler.ts` (`reconcilers`) is code wiring, not state.

## Outstanding work

### Code

1. **Done — Decide each host-wide cache.** See Current state and decision 2:
   seven stay process-wide with a comment at the declaration;
   `container-resources.ts`'s usage sample moved because it is owner-filtered.
   `environment-cleanup.ts`'s `loggedKeptBranches` stays (decision 3).
2. **Done — Move each per-backend row into its owner.** No `set*`/`reset*`
   seam is left for the moved state: `setLocalClaudeConfigDirectoryProvider`,
   `getLastTmuxOrphanSweepAt`, `setLastTmuxOrphanSweepAt`,
   `setSignalInstaller`, the registry option `claudeStatePolls`,
   `waitForPendingFeatureTitleRefinements`, `resetCleanupGrants`,
   `resetAgentAccountLastUsageForTests`, `setLocalClaudeLoginRefresher`,
   `setLocalCodexLoginRefresher`, `setHostClaudeLoginRefresher`,
   `startOomEventWatcher`, `shutdownOomEventWatcher` and the exported
   `linearCompletionCommentLocks`/`githubCompletionCommentLocks` are gone;
   `git grep` for each in `apps tests scripts packages` finds nothing.
   `resetResourceCaches` stays for the two daemon caches. The tmux rows moved
   together into one `TmuxRuntime`.
3. **Done — Allowlist.** `tmux-session-manager.ts` is off the
   `import/no-mutable-exports` allowlist in `.oxlintrc.json`; `mise run lint`
   exits 0.
4. **Done — Two-backend test.** `backend-runtime.test.ts` has 14 cases (8
   from 0011 and 0066). The six new ones prove these are per backend: tmux
   sessions reached through `claude_tmux_status`/`claude_tmux_interrupt`,
   interactive panes and the orphan sweep; tmux activity writes; Claude state
   polls through `reconcile_claude_state_polling` and their shutdown; Docker
   cleanup grants, the usage sample and the OOM follower; GitHub/Linear locks,
   feature-build tasks and public API reconciliations; the Cursor SDK login,
   login refreshers, Keychain clears and the loaded last-usage store.

### Qualification

Run on this host (macOS, Apple Silicon) on 2026-10-27: see Validation
evidence.

## Validation evidence

- `mise run format:check`: passed. `mise run lint`: exit 0, no findings in
  changed files. `mise run typecheck`: passed.
- `backend-runtime.test.ts` alone: 14 pass.
- Focused run of the 69 touched or affected backend files (tmux, accounts,
  Cursor, GitHub, cleanup, container resources, OOM, feature build, public
  API, coordinator, environment move, index, state sync) at `--parallel=4`:
  1,552 pass, 41 fail. 11 were real regressions in this work: tests calling
  `cleanupEnvironmentTmux` directly with hand-built contexts without a
  runtime (`tmux-commands-teardown.test.ts`, `tmux-commands-mcp.test.ts`).
  Fixed with `harnessContext()` in `tests/tmux-test-harness.ts`. The other
  30 (`environment-move.test.ts`, one `public-api-project-init-cascade`
  case) were 5 s test timeouts with load average 127–177 on this host. With
  `--timeout 60000` at `--parallel=1`, `environment-move.test.ts` passed in
  full (396 s), and the cascade file plus both tmux files passed (32 s).
- Root guards `module-import-cycles`, `merge-cleanup-scheduler` and
  `inheritance-chains`: passed.
- `mise run test`, exit 1 both times. The first run (inside `test:logged`)
  was killed by the wrapper's 30-minute deadline after the workspace group
  queued 1,329 s for worker slots on this shared host. The second, with
  `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000`, finished in 2,807 s: web,
  web-public, CLI, protocol, toolchain, the codex protocol lockfile and four
  of five bridges passed; backend 12,003 pass, 120 skip, 52 fail; desktop 2
  fail; root 3 fail; claude-bridge 3 fail. One backend failure was a real
  regression of this work: `host-suspend-detector.test.ts` expected the
  `claude-state-signal` source to be registered at module load. It now
  builds a `BackendRuntime` and checks that both sources are registered and
  removed on shutdown (8 pass). Every other failure is classified in flaky
  case
  [1195](../../tests/flaky-tests/aggregate-validation-runs/1195-backend-module-state-0133-validation.md):
  load deadlines that pass alone or with `--timeout 60000`, and
  deterministic host failures (`staged-input-relay`, docker-image
  `pinned image identity`, `migrate-copy`) that fail identically on the base
  commit `863b5782`. None of those owning files is changed by this branch
  beyond comments.
- Scenario suites (`test:agent:browser:isolated`, `test:agent:docker`,
  `test:agent:electron`) were not run: the change is backend-internal state
  ownership with no renderer, Electron or Docker lifecycle change, and
  production runs one backend per process.

## Assumptions and decisions

1. **One `TmuxRuntime` for all tmux state, on `BackendRuntime`.**
   - Options: a tmux sub-object of `TerminalRuntime`; a new `tmux`
     property; one property per tmux singleton.
   - Chosen: `runtime.tmux` (`TmuxRuntime`), holding sessions, interactive
     panes, state polls, activity writes and the orphan sweep.
   - Why: they share sessions, install locks and timers (the todo asked for
     them to move together), and `TerminalRuntime` owns PTYs, a separate
     lifecycle.
   - Pros: one owner, one `shutdown()`, `TerminalRuntime` unchanged. Cons:
     one more top-level property.
2. **The container usage sample moves; the daemon caches stay.**
   - Options: keep every `container-resources.ts` cache process-wide (the
     todo's listing); move all; split.
   - Chosen: split. `capacityCache` and `diskCache` describe the daemon and
     stay; `usageCache`/`inflight` moved to `runtime.containerUsage`.
   - Why: `sampleNow` lists only containers labelled with this backend's
     owner and carries this backend's OOM counts, so a shared sample showed
     one backend's containers to another for 5 s.
   - Pros: fixes that cross-backend leak; the OOM count now comes from the
     same backend. Cons: `resetResourceCaches` no longer clears the usage
     sample; tests that need a fresh one use a fresh runtime (all fixture
     contexts already build one).
   The other host-wide entries stay process-wide; the reason for each is at
   its declaration and in `backend-runtime.md`.
3. **`loggedKeptBranches` stays.**
   - Options: move it to `EnvironmentOperations`; leave it.
   - Chosen: leave it, documented. It only de-duplicates a warning; sharing it
     costs at most one log line.
4. **Registrations become construction options.**
   - The tmux local Claude config provider, the Claude state doorbell and the
     three login refreshers were module registrations (two set from
     `commands-servers.ts` at load, three from `index.ts` in `init()`).
   - Chosen: `BackendRuntimeOptions.tmux` and `.accounts`, passed by
     `index.ts` (and the tmux provider also by `tests/command-fixtures.ts`, as
     `scheduleMergeCleanup` already was).
   - Why: a registration is shared by every backend; the rules in
     `backend-runtime.md` ask for construction options.
   - Pros: no module state, no load-order dependence. Cons: a runtime a test
     passes to `Backend` as `options.runtime` gets no refreshers or doorbell
     unless the test passes them, as with `worktreeSignal` before.
5. **A refresher that returns `undefined` counts as "nothing asked".**
   - Options: closures that always resolve (an extra credential re-read
     before `init()` and after `shutdown()`); a getter for the refresher; a
     return value of `undefined` meaning no keeper.
   - Chosen: `undefined` means no keeper; `AgentAccountsRuntime` returns
     `false` and the caller skips the re-read, exactly as an unregistered
     refresher did.
   - Pros: identical behaviour before `init()` and after `shutdown()`; tests
     keep a variable and pass a delegating closure. Cons: the option type is
     `Promise | undefined`, which needs the comment it has.
6. **Claude state polls take options, not an instance.**
   - Options: inject a `ClaudeStatePollManager` instance; options.
   - Chosen: `tmux.claudeStatePolls: ClaudeStatePollManagerOptions`; the
     doorbell is `options.signal`, so `setSignalInstaller` is gone and the
     installer is fixed at construction.
   - Why: no test injected an instance through the registry except the one
     that checked the production wiring, which now checks
     `backendClaudeStateSignal()`.
   - Pros: no setter; per-runtime diagnostics registration. Cons: a test that
     wants to spy on the manager reads `runtime.tmux.claudeStatePolls`.
7. **Runtime shutdown stops this backend's poll and pane timers.**
   - Options: leave them running until process exit, as the process-wide
     singletons did; stop them in `runtime.shutdown()`.
   - Chosen: stop them (`claudeStatePolls.shutdownAll()`,
     `interactiveTerminals.detachAll()`), and stop the OOM follower there too
     (idempotent with the backend's own stop at the same point as before).
     tmux sessions themselves are never stopped: they outlive the backend.
   - Why: "timers are cleared by the owner's `shutdown()`" (0011/0066).
   - Pros: no `docker exec` after shutdown; tests release timers. Cons: in
     production these timers now stop a little before process exit rather
     than at it.
8. **A tmux session reaches its owner through its context.**
   - Options: store the owning `TmuxRuntime` in each `TmuxSession`; read
     `context.runtime.tmux` at call time.
   - Chosen: the context. Every session method that touches the manager
     (the poll loop's liveness removal, observations, hook busy state,
     startup's account directory) already receives the context it was
     started with.
   - Pros: no constructor change; `tmux-initial-prompt.test.ts` unchanged.
     Cons: a hand-built context needs a runtime; `tests/tmux-test-harness.ts`
     supplies the per-test one (`invoke`, and `harnessContext()` for direct
     calls).
9. **GitHub client functions take the locks as their first parameter.**
   - Options: an options bag; a trailing parameter (impossible after the
     defaulted `fetchImpl`); first.
   - Chosen: first (`ensureGitHubWorkflowLabels`, `listGitHubIssues`,
     `updateGitHubIssueStatus`), typed as the narrow `GitHubWriteLocks`.
   - Pros: the label and status locks follow the backend; only three
     signatures change. Cons: `github.test.ts` passes one `IntegrationLocks`
     shared by the file, as the module maps were.
   The completion-comment chains keep their semantics, including that a
   rejected earlier task rejects the next (`previous.then(task)`); changing
   that is out of scope.
10. **Feature builds and the public API share `KeyedSingleFlight`.**
    - Options: a class per map with hand-written join logic; one small
      generic helper.
    - Chosen: `KeyedSingleFlight` (`keyed-single-flight.ts`), wrapped by
      `FeatureBuildTasks` and `PublicApiReconciliations` with named methods.
    - Pros: four identical join-or-start blocks become one. Cons: one more
      tiny file.
11. **Unlisted per-backend state goes to a new todo, 0390, rated Low.**
    - Options: widen this branch; record it.
    - Chosen: record it in
      [0390-backend-module-state-beyond-0133.md](0390-backend-module-state-beyond-0133.md)
      (agent-account logins, usage caches and mutation chain, container login
      pushes and MCP digests, the plan-usage cache's active account, the
      GitHub CLI and OpenCode provider logins, the container log service, the
      OpenCode command journals). The host refresher in
      `agent-accounts-containers.ts` was moved here although unlisted, because
      `index.ts` registered it with the two listed refreshers and leaving one
      would have kept that block half-migrated.
    - Why: this file's scope was its rows, and other open branches touch the
      account and storage files; the README forbids adding items here.
12. **This file is kept until the branch merges.**
    - Options: delete it now (README rule for finished files); keep it with
      Finished: Yes until merge.
    - Chosen: keep it, as 0010, 0011, 0013 and 0066 do, so the review sees the
      decisions and evidence; the durable description is in
      `backend-runtime.md`.
13. **The full suite ran with a raised group deadline.**
    - Options: rerun unchanged and hope for free worker slots; raise the
      deadline for one invocation, as the testing guide allows.
    - Chosen: `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000` for the second run.
    - Why: the first run's workspace group spent 22 minutes queued behind
      other sessions' suites and was killed with no result.
    - Pros: a complete result for every group. Cons: it is not the default
      configuration, and the run was not green (see Validation evidence and
      case 1195); a green full suite on a quiet host is still needed.

## Needs verification

- A green `mise run test` on a quiet host. On this host every remaining
  failure is either a load deadline or a failure that reproduces on the base
  commit (case 1195), but the suite as a whole did not pass.
- A production backend run (not done: this host runs the user's live
  Orkestrator, so no backend was started against a real data directory). It
  would confirm a claude-tmux tab exports the active account's
  `CLAUDE_CONFIG_DIR`, Claude state polls arm the doorbell in a container,
  the usage view shows OOM counts, and coordinator Claude/Codex logins are
  refreshed through the keeper, all through the new construction options.

## Constraints and rationale

The same as 0011 and 0066: one class per owner with private state, reached
through `context.runtime` at call time, never destructured at module load;
timers are cleared by the owner's `shutdown()`. Production runs one backend
per process, so none of this changes shipped behaviour, except that the
usage sample no longer crosses backends (decision 2) and poll and pane timers
stop at runtime shutdown (decision 7).

## Related

- [0066-backend-residual-module-state.md](0066-backend-residual-module-state.md)
- [0011-backend-runtime-state-ownership.md](0011-backend-runtime-state-ownership.md)
- [0390-backend-module-state-beyond-0133.md](0390-backend-module-state-beyond-0133.md)
- [`backend-runtime.md`](../../architecture/backend-runtime.md)
- [0733-two-backends-share-process-watchers.md](0733-two-backends-share-process-watchers.md): the OOM watcher, login refresher and container log service shutdown interference, split out.
