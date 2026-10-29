# Backend runtime state ownership

Planned against `main` at `2459b05c` (2026-10-15). Done on
`todo-0011-runtime-state-ownership-c6dc8595c4e6` from `8454d18b`
(2026-10-24). Every item below is done. The durable description now lives in
[`backend-runtime.md`](../../architecture/backend-runtime.md); module state that
was outside this file's scope is listed in
[0066-backend-residual-module-state.md](0066-backend-residual-module-state.md).
Delete this file and its index row once the branch has merged (decision 15).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Retire this finished file**: all six code steps, the two-backend test and the qualification are done and merged (#1209); only the file's own retirement remains. Status: done.

### 1. Retire this finished file

**Problem.** The file is marked Finished and says to delete it with its index row once the branch merged (decision 15). It still holds rank 8 in the folder index, and a production source comment points readers at it.

**Context.** The README rule: move durable behaviour into `architecture/`, delete the file, remove the row. Residual module state went to [0066](0066-backend-residual-module-state.md) (finished) then 0133 (finished and deleted), and now [0390](0390-backend-module-state-beyond-0133.md) (open).

**Investigation.** The branch merged as `8290f2ca` (#1209), after the earlier `diffStats` step in `404b1f3b` (#978). The claims hold at HEAD: `commands-runtime-state.ts` and `agent-account-bridge-state.ts` are gone, and `git grep` finds only the historical comment at `tests/unit/module-import-cycles.test.ts:28`. `BackendRuntime` has the clusters (`apps/backend/src/core/backend-runtime.ts:35` to `:39`, plus `containerStates` and `changeTracking` from 0066), and `backend-runtime.test.ts` has the three 0011 cases (`:68`, `:106`, `:154`) among its eight. The `import/no-mutable-exports` allowlist in `.oxlintrc.json` now has 43 entries, consistent with 0011's 45 less 0066's two. The durable description is in `docs/architecture/backend-runtime.md` (clusters table, the rules for reaching state at call time and passing narrow clusters, construction-option test seams, shutdown order), and it already covers decisions 4 (`EnvironmentLifecycleTaskTracker` kept separate), 6 (seams as options) and 8 (local-server teardown in the backend's awaited shutdown). Inbound references a deletion must update: the class doc comment at `backend-runtime.ts:26` names this file by path, and 0066 and 0133 link to it.

**Decisions.**

- **What to do with this file now that its branch has merged?**
  - **Delete it now, pointing the source comment at `backend-runtime.md` (recommended).** Change the path in `backend-runtime.ts:26` to `docs/architecture/backend-runtime.md`, repoint the 0066/0133 links, remove the index row.
    - Pros: follows the README rule; the architecture doc already carries every rule a contributor needs; the source comment then points at living documentation rather than a closed plan.
    - Cons: the deletion touches a production source file (a comment only), so the change is not documentation-only and needs the code validation path.
  - **Delete it and leave the source comment until the next edit of `backend-runtime.ts`.**
    - Pros: a documentation-only change.
    - Cons: leaves a dangling path in production code.
  - **Keep it until 0133 is done.**
    - Pros: one retirement for the whole runtime-state series.
    - Cons: contradicts the README rule; 0133 is low priority with no date.

`apps/backend/src/core/commands-runtime-state.ts` was the backend's
process-wide state bag: terminal, local-server and environment-operation maps
exported as module globals, plus setters that existed so tests could replace
them. Every `CommandContext` in one process shared the same maps, so two
backends in one test could not be told apart. The goal was to move that state
into the per-backend `BackendRuntime` reached through `CommandContext.runtime`,
delete the module, and take it off the `import/no-mutable-exports` allowlist.

## Current state

- `BackendRuntime` (`backend-runtime.ts`) owns four clusters, each a class with
  private state, built per backend (`core/index.ts`) and per fixture context:

  | Property | Class | File | Replaces |
  | --- | --- | --- | --- |
  | `diffStats` | `DiffStatsTracking` | `diff-stats-tracking.ts` | (before this work, #978) |
  | `terminals` | `TerminalRuntime` | `terminal-runtime.ts` | the 17 terminal maps/sets, `nextTerminalActivityGeneration`, `terminalOutputRetentionMs` |
  | `localServers` | `LocalServerRuntime` (+ `openCodeAgentTools`: `OpenCodeAgentToolsReconciler`, `opencode-agent-tools.ts`) | `local-server-runtime.ts` | the 18 local-server bindings, `openCodeLaunchAgentToolConnections`, the three OpenCode tuning `export let`s in `commands-servers.ts`, and all five maps of `agent-account-bridge-state.ts` |
  | `environments` | `EnvironmentOperations` | `environment-operations.ts` | the 9 environment-operation bindings |

- `commands-runtime-state.ts`, `agent-account-bridge-state.ts` and
  `tests/unit/commands-runtime-state-load-order.test.ts` are deleted.
  `git grep "commands-runtime-state\|agent-account-bridge-state" -- apps tests`
  finds only a historical comment in `tests/unit/module-import-cycles.test.ts`.
- The stateless remainder moved next to its users: container scripts and
  sentinels to `container-scripts.ts`; credential paths, agent-test env names
  and the OpenCode GitHub plugin to `agent-credential-files.ts`;
  `LocalServerKind`, `LOCAL_SERVER_KINDS`, `BRIDGE_TOKEN_PATTERN`,
  `retryableBridgeStartupError`, `localServerStopCommandName` and the shutdown
  timings to `local-server-runtime.ts`; health/reuse constants to
  `commands-server-health.ts`; the busy-unresponsive constants to
  `commands-servers.ts`; the Claude catalogue timings to
  `commands-containers.ts`; `WORKSPACE_ARTIFACT_GIT_EXCLUDE_PATTERNS` to
  `commands-files.ts`; terminal buffer and activity constants to
  `terminal-runtime.ts`; setup-session types to `environment-operations.ts`.
- The `import/no-mutable-exports` allowlist went from 49 to 45 entries:
  `commands-runtime-state.ts`, `commands-servers.ts`, `commands-files.ts` and
  `commands-agent-support.ts` are off it. `commands-container-exec.ts` keeps its
  entry (`export let dockerContainerStateCache`, tracked in 0066).

## Outstanding work

### Code

All six steps are done, in one branch and one PR (decision 1).

1. **Done — `TerminalRuntime`.** The 19 terminal bindings and every function
   that touched them (`appendTerminalOutputBuffer`, `cleanupTerminalSession`,
   the activity tracking, stable keys, orphan reaping, …) are methods on
   `TerminalRuntime`. Output retention is the constructor option
   `terminals.outputRetentionMs`; `commands-registry-terminal.test.ts` builds a
   context with `runtimeOptions: { terminals: { outputRetentionMs: 5 } }`
   instead of calling `setTerminalOutputRetentionMs`. `shutdown()` clears every
   retention, activity and completion-retry timer.
2. **Done — `LocalServerRuntime`.** Spawn and terminate are constructor options
   (`localServers.spawn`, `localServers.terminateProcessTree`); the shutdown
   flag and promise are private (`closeAdmission()`, `isShuttingDown()`,
   `shutdown()`). Consumers without a context in reach get the narrow piece:
   `withShortLivedBridge(localServers, …)` in `host-model-catalog-refresh.ts`,
   the `localBridgeAccountId` callback on `NativeAgentService`, and
   `onLoginChanged(context)` in `opencode-provider-login.ts`;
   `pi-model-catalog-seeding.ts` and `agent-accounts-active.ts` already had a
   context. It also owns the five `agent-account-bridge-state.ts` maps
   (decision 3).
3. **Done — `EnvironmentOperations`.** The 9 bindings are private behind
   `joinStart`, `joinSetupStart`, `joinBaselineCapture`, `trackSetupTask`,
   `enqueueLifecycleOperation`, `beginDelete`/`endDelete`,
   `beginMerge`/`endMerge`, `scheduleMergeCleanupRecovery` and read
   accessors. Kept separate from `EnvironmentLifecycleTaskTracker`
   (decision 4).
4. **Done — Delete the module.** See Current state. `mise run lint` exits 0
   with the four entries removed.
5. **Done — Two-backend test.** `apps/backend/src/core/backend-runtime.test.ts`
   builds two `BackendRuntime`s in one process. A terminal registered in one is
   absent from the other's `list_terminal_sessions`, `terminal_write` and
   `get_terminal_output_buffer` commands; a local server owned by one is
   invisible to the other, and shutting one down neither closes the other's
   admission nor terminates its process; delete guards and lifecycle queues are
   per backend. 3 pass.
6. **Done — Sibling dynamic imports.** The `cursor_sdk_login_*` and
   `cursor_sdk_logout` handlers in `commands-registry-projects.ts` and
   `defaultRunners` in `cursor-sdk-bridge.ts` now import statically; neither
   was dodging a cycle (`module-import-cycles.test.ts` still passes with an
   empty `KNOWN_CYCLES`). A search found one more that was a real cycle dodge:
   `public-api/run-observer.ts` lazily imported `actions-launch.ts`, which
   imports `run-observer.ts`. `actions-launch.ts` now registers its own
   `environment.launch` reconciler, as `actions-exec.ts` and `actions-host.ts`
   already do. The one remaining sibling `await import()` in production,
   `design/export-writer.ts` → `export-directory.ts`, keeps `bun:ffi` out of
   Node-run browser tests and turns a load failure into `root-unavailable`; it
   is not a cycle dodge (`export-directory.ts` imports nothing from `design/`).

Done when (all met):

- `commands-runtime-state.ts` no longer exists, and no `set*`/`reset*` seams
  for backend state remain. The `__testing` object (`commands-testing.ts`)
  keeps only pure helpers plus `resetOpenCodeHostStart` and
  `resetTerminalHistory`, which reset module state outside this file's scope
  (0066; both were removed there).
- `CommandContext.runtime` is the only path to terminal, local-server,
  environment-operation and diff-stats state. The backend itself reaches its
  own runtime from `index.ts` (shutdown, the `NativeAgentService` account
  callback).
- The two-backend test exists.
- The allowlist shrank by four entries and `mise run lint` is clean.
- No production code calls `await import()` on a sibling backend module just to
  avoid a cycle.

### Qualification

Run on node mbp3 (macOS, Apple Silicon, Docker 29.7.2) on 2026-10-24:

- `mise run format:check`: passed.
- `mise run lint`: exit 0, no backend warnings.
- `mise run typecheck` (through `test:logged`): passed.
- `mise run test:agent:browser:isolated` (through `test:logged`): passed
  (491.4 s; disposable profile started, suite run, profile reset).
- `mise run test`: see the Validation evidence below. The first run (with the
  browser suite running alongside) failed in 19 backend cases: five were real
  regressions of this work (hand-built contexts without a `runtime` in
  `host-maintenance-readers.test.ts`, `inherited-agent-connection.test.ts`,
  `tests/unit/merge-cleanup-scheduler.test.ts`, and the changed
  `enqueueContainerBridgeOperation` dependency signature in
  `commands-projects.test.ts`), all fixed; 14 were the OpenCode
  execution-policy conformance cases that expect CLI `1.19.0` while this host
  has `1.19.4` (pre-existing, recorded in flake cases 0310 and 0512); one was
  `review-validation-worker.test.ts` under load (new flake 0745). The CLI
  package had one load timeout (new flake 0746).

## Validation evidence

- Focused runs of every migrated test file passed (agents' and my runs,
  `bun test --cwd apps/backend …`): group A 8 files (205 tests), group B 11
  files (365 pass, 9 live-Docker skips), group C 21 files (561 pass),
  `backend-runtime.test.ts` 3 pass, `src/core/public-api` with
  `cursor-sdk-bridge.test.ts` passed, `module-import-cycles.test.ts` and
  `runtime-env-wiring.test.ts` passed.
- Final `mise run test` (nothing else running on the host, 709 s): bridges,
  codex protocol lockfile, web (9,166 tests), desktop (1,245), protocol
  (1,832), CLI (227), web-public and toolchain passed. Backend: 10,444 tests,
  10,314 passed, 115 skipped, 15 failed: the 14 OpenCode `1.19.0`-vs-`1.19.4`
  conformance cases above, and `restart reconciliation > a kill at any phase
  before the commit write leaves the original authoritative`
  (`container-replacement.test.ts`), a known flake (0244) whose owner passed
  alone (11.2 s). Root: 3,382 tests, 3,377 passed, 5 failed, all
  `tests/unit/firewall-policy.test.ts` timeouts; that owner also fails alone on
  this host, identically in a clean `origin/main` worktree (11 pass, 13 fail),
  so it is a host condition, recorded on case 0632. No failure in either run is
  in code this branch changed after the fixes above.

## Assumptions and decisions

1. **One branch and one PR instead of one PR per step.**
   - Options: one PR per step as the file planned; one PR for all six.
   - Chosen: one PR, as the task instruction required.
   - Why: the instruction overrides the file's plan; the steps also share
     consumer files (`commands-servers.ts` touches all three clusters), so
     separate PRs would have re-edited the same lines three times.
   - Pros: one consistent API change, one review, no intermediate states with
     half the state global. Cons: a large diff (about 100 files) that is harder
     to bisect inside.
2. **Cluster shape: three classes plus a reconciler sub-object.**
   - Options: one large runtime class; one class per cluster; finer classes
     per map group.
   - Chosen: `TerminalRuntime`, `LocalServerRuntime`, `EnvironmentOperations`,
     with OpenCode MCP reconciliation as `LocalServerRuntime.openCodeAgentTools`
     (`OpenCodeAgentToolsReconciler`).
   - Why: matches the file's "one class per cluster" constraint; the OpenCode
     reconciliation (configurations, outcomes, launch connections, tuning,
     retry loop) is self-contained and would otherwise dominate
     `LocalServerRuntime`.
   - Pros: each class small enough to read; private maps; behaviour-named
     methods. Cons: one more indirection (`localServers.openCodeAgentTools`).
3. **`agent-account-bridge-state.ts` folded into `LocalServerRuntime`.**
   - Options: keep the module; a separate `AgentAccountBridges` class; fold
     into `LocalServerRuntime`.
   - Chosen: fold all five maps (the file named four; `loginlessLocalBridges`
     was added since). Launch facts are recorded by
     `adoptProcess(key, child, launch)` and cleared by `releaseOwnership`.
   - Why: four of them are keyed by the bridge's process key and were already
     cleared in `releaseLocalServerOwnership`; they share the bridge's
     lifetime. `staleLoginEnvironmentIds` (container environments) went along
     so the module could be deleted rather than left half-populated.
   - Pros: one owner for everything known about a bridge; the module and its
     invisible `export const` maps are gone. Cons: `LocalServerRuntime` carries
     a container-login hint that is not strictly a local server concern.
4. **`EnvironmentOperations` kept separate from
   `EnvironmentLifecycleTaskTracker`.**
   - Options: fold the 9 bindings into the tracker; keep two classes.
   - Chosen: two classes; `enqueueLifecycleOperation` takes the tracker.
   - Why: once side by side, the tracker decides admission and drains on
     shutdown (and is injected separately by `index.ts` and fixtures), while
     the operations class orders and deduplicates admitted work per
     environment. Folding would change the tracker's constructor surface and
     its shutdown semantics.
   - Pros: no change to admission/drain behaviour; each class has one job.
     Cons: two objects to pass for lifecycle work.
5. **The delete and merge guards and merge-cleanup recovery live in
   `EnvironmentOperations`.**
   - Options: `LocalServerRuntime` (the old names said "local server");
     `EnvironmentOperations` (the file's table).
   - Chosen: `EnvironmentOperations`, per the table.
   - Why: they guard environment deletion and merges for every consumer
     (review, move, terminals), not only local servers.
   - Pros: matches meaning. Cons: `assertLocalServerStartAllowed` now consults
     two clusters.
6. **Test seams are construction options; fixtures own their mid-test swaps.**
   - Options: keep setter methods on the runtime; construction options only;
     construction options plus test-owned delegating hooks.
   - Chosen: construction options, and in `tests/command-fixtures.ts` a
     test-owned `localServerHooks` object every fixture runtime delegates to
     (reset in `afterEach`). Unit tests keep a local `let` and pass a
     delegating function.
   - Why: the file requires no `set*`/`reset*` seams for backend state; many
     tests swap terminate/spawn mid-test (fail, then succeed), which a
     delegating option preserves without a backend setter.
   - Pros: backend code has no test setters; tests remain readable. Cons: the
     fixture has its own mutable hook object (test code only).
7. **Fixture contexts keep a fresh runtime each (status quo since #978), with
   opt-in sharing.**
   - Options: a per-test shared runtime (mimicking old global state); a fresh
     runtime per context with `createContext(…, { runtime })` to share.
   - Chosen: fresh per context, opt-in sharing.
   - Why: it is what "two backends cannot be told apart" asks to fix, and
     fixtures already built one runtime per context. Only one test needed
     sharing (`commands-io-coverage.test.ts`, a second status read).
   - Pros: tests now exercise per-backend isolation. Cons: tests that injected
     global state had to name the context's runtime explicitly.
8. **Local-server teardown stays in the backend's awaited shutdown.**
   - Options: make `BackendRuntime.shutdown()` async and terminate servers;
     keep `runtime.shutdown()` synchronous and call
     `runtime.localServers.closeAdmission()` / `.shutdown()` from `index.ts`.
   - Chosen: the latter.
   - Why: servers must be terminated after lifecycle work drains, at the same
     point `shutdownLocalServers()` ran before; `runtime.shutdown()` runs early
     and synchronously. SIGINT/SIGTERM still reach it through
     `createBackendShutdownHandler`.
   - Pros: identical shutdown order. Cons: runtime shutdown is two calls, not
     one (documented in `backend-runtime.md`).
9. **`TerminalRuntime.shutdown()` clears terminal timers.**
   - Options: leave timers to process exit (old behaviour); clear them.
   - Chosen: clear retention, activity and completion-retry timers (all were
     already `unref`'d).
   - Why: the file's constraint ("timers are cleared by that cluster's
     `shutdown()`; tests should find no live timers after teardown").
   - Pros: no timer outlives a fixture runtime. Cons: a terminal activity
     completion still retrying at backend shutdown is no longer recorded; the
     process is exiting and storage closes shortly after anyway.
10. **Behaviour-preserving details kept on purpose.**
    - `trackSetupTask` deletes the setup task unconditionally when it settles,
      as before, rather than only when it is still the current task.
    - The short-lived catalogue/sign-in probe's start gate checks only the
      shutdown flag. The old call also checked the delete guard with a probe
      key (`catalog-refresh:claude`) that can never be an environment id, so
      the result is identical.
    - Docker cleanup's `ProtectionSnapshot` gained an
      `operationInFlight(environmentId)` predicate that reads
      `runtime.environments.hasLifecycleWork` live at classification time, as
      the module-level check did, rather than a snapshot set.
11. **Stateless constants moved to new leaf modules and their users.**
    - Options: one `commands-constants.ts`; scatter each constant into its
      main user; two themed leaves plus users.
    - Chosen: `container-scripts.ts` and `agent-credential-files.ts` for the
      two shared themes; everything with one main user moved into that user.
      The `commands-helpers.ts` barrel re-exports the new leaves so existing
      barrel imports keep working.
    - Pros: no new grab-bag module; leaves have no backend imports, so no
      cycles. Cons: barrel re-exports hide where a name lives.
12. **OpenCode tuning moved into the reconciler's constructor.**
    - Options: leave the three `export let`s in `commands-servers.ts`; move
      them.
    - Chosen: move (`localServers.openCodeAgentTools` options), which took
      `commands-servers.ts` off the allowlist.
    - Pros: no setter seams; allowlist shrinks. Cons: tests that tuned after
      construction now build their runtime with the tuning up front (one memo
      test now starts with a zero window; its expected POST count still holds).
13. **Allowlist entries checked with the rule.**
    - `commands-files.ts` and `commands-agent-support.ts` had no `export let`
      left and were removed; `commands-container-exec.ts` still exports
      `dockerContainerStateCache` and keeps its entry (0066).
14. **Residual module state goes to a new todo, 0066, rated Low.**
    - Options: widen this branch to move it; leave it unrecorded; record it.
    - Chosen: record it in
      [0066-backend-residual-module-state.md](0066-backend-residual-module-state.md)
      (terminal history, `terminalAccountHomes`, the environment replacement
      fence, OpenCode host-start, Pi catalogue seeding, container-state cache,
      PR monitor).
    - Why: this file's scope was the two modules; the README forbids adding
      new items to an existing file.
    - Rating: Low, because production runs one backend per process, so leaving
      it changes no behaviour; it only limits two-backend tests.
15. **This file is kept until the branch merges.**
    - Options: delete it now (README rule for finished files); keep it with
      Finished: Yes until merge.
    - Chosen: keep it, as 0010 does, because the task asked for the decisions
      and evidence to be recorded here; the durable description is in
      `backend-runtime.md`.

## Constraints and rationale

- Never destructure the runtime at module load (for example
  `const { terminals } = someRuntime` at module scope). That recreates the
  value-capture bug #417 caused, where an `Object.assign` snapshot froze `let`
  exports. Always reach the runtime through the context at call time.
- One class per cluster, each owning its maps privately. Callers use methods
  named for what they do, not `.get()`/`.set()` on a shared map. A read-only
  accessor is fine where a method would only wrap one map operation.
- Timers belong to their owner and are cleared by that cluster's `shutdown()`.
- Keep identity semantics. Where two clusters read one map, the owning cluster
  has a query method rather than sharing the map object.
- Backend shutdown calls `runtime.shutdown()` exactly once, after the gateway
  stops accepting commands; local servers are reached through
  `runtime.localServers` on the backend's shutdown path.
- This lands before the `commands` slice of
  [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md).
- Out of scope: the other modules on the `no-mutable-exports` allowlist,
  including the bridges' session-manager state.

## Related

- [`backend-runtime.md`](../../architecture/backend-runtime.md)
- [0066-backend-residual-module-state.md](0066-backend-residual-module-state.md)
- [0012-backend-core-domain-folders.md](0012-backend-core-domain-folders.md)
- [`linting.md`](../../development/linting.md) ("Module boundaries",
  `import/no-mutable-exports`).

## Replaces

- `docs/2026-10-14/runtime-state-ownership.md`
