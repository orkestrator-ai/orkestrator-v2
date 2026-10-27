# Backend module state beyond 0066

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
