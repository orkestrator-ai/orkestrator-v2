# Backend module state beyond 0390

Found while doing [0390](0390-backend-module-state-beyond-0133.md) on
`todo-0390-backend-module-state-2ae5bfedeb60`. A scan of `apps/backend/src/core`
for module-level `let`s and `Map`/`Set` singletons turned up more state that
0390's table did not list. Two backends in one process may share it.

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`; re-checked 2026-11-01 against
`main` at `93b99bfb` (see Assumptions and decisions).

### Tasks

1. **Sort the remaining module state**: decide, per row of Current state, whether it moves onto `BackendRuntime` or stays process-wide and documented. Status: done.
2. **Move the per-backend rows**: move what task 1 marks per-backend, with a two-backend case for each; the three rows left are tasks 3 to 5. Status: done.
3. **Move the managed GitHub CLI binary**: `github-cli-binary.ts` `managedGitHubCli`. Status: open.
4. **Move the host model catalogue seed state**: `host-model-catalog-seed.ts` `failedAt`, `generations`, `flights`; waits for the account code another build is changing. Status: open.
5. **Move the worker tab close admission**: `worker-tab-close-admission.ts` `closing`, `pending`. Status: open.

### 1. Sort the remaining module state

**Problem.** The rows below were module state that was neither on `BackendRuntime` nor in the "Process-wide on purpose" table, so nothing said whether two backends may share them.

**Context.** [`backend-runtime.md`](../../architecture/backend-runtime.md) holds the rules and the table. Production runs one backend per process, so none of this changes shipped behaviour.

**Investigation.** Done: every row was read for its keys and callers. The Decision column of Current state records the outcome and its reason.

**Decisions.**

- **How to sort them?**
  - **Read each row's keys and callers, then record per row: moves, or stays and is marked next to its declaration and added to the table (recommended).**
    - Pros: the same test 0390 applied; state keyed by a data-directory path or by a host resource needs no plumbing.
    - Cons: reading about twenty modules before any code changes.
  - **Move every row.**
    - Pros: one rule, and no reading of keys.
    - Cons: plumbing for state that cannot collide, and host bounds would multiply.

### 2. Move the per-backend rows

**Problem.** Rows task 1 marks per-backend are still shared by two backends in one process.

**Context.** The pattern is 0390's: an owner class with private state, reached through `context.runtime` at call time.

**Investigation.** Done for eight rows (see Assumptions and decisions). Three rows need plumbing or code outside this change and are tasks 3 to 5.

**Decisions.**

- **How to split the work?**
  - **One commit per owner, on one branch per reviewable group (recommended).**
    - Pros: each diff has one subject; matches 0390.
    - Cons: several branches over time.
  - **One branch for everything.**
    - Pros: done in one go.
    - Cons: too large to review.

### 3. Move the managed GitHub CLI binary

**Problem.** `managedGitHubCli` (`github-cli-binary.ts:16`) is the `gh` the backend runs. It comes from the backend's data directory (the pinned toolchain, or `toolchains/gh-latest` under the data directory on the latest channel), so a second backend in one process overwrites the first's choice, and the first then runs the second's binary.

**Context.** It is set by `index.ts:625` at construction and by `host-maintenance-tasks.ts` (`applyGhChannel`, `:285` and `:289`; `startGhUpdate`, `:379`) when the channel changes. Six test files set it directly.

**Investigation.** `gitHubCli()` has 16 production calls in 10 modules: `commands-pr-monitor.ts` (3), `github-clone-browser.ts` (4), `commands-review.ts` (2), and one each in `bug-report-service.ts`, `host-maintenance-readers.ts`, `github-credentials.ts`, `graph-system-environment.ts`, `commands-projects.ts`, `agents-md-pr.ts` and `github-cli-setup.ts`. Most sit next to a `gitHubCliEnv(source)` call, but that source is the storage's config, which does not know the binary. `github-clone-browser.ts` and `github-git-credentials.ts` hold only that source; `host-maintenance-readers.ts` and `github-credentials.ts` resolve tokens with no source at all.

**Decisions.**

- **Where does the selected binary live?**
  - **A small owner on the runtime (`runtime.gitHubCli`, holding the pinned path and the channel's choice), with `gitHubCli(selection)` taking it like `gitHubCliEnv` takes its source (recommended).**
    - Pros: follows the runtime rules; the channel setters become methods; tests build a fresh runtime instead of resetting a module.
    - Cons: every call site and the clone browser's and token readers' signatures change; about a dozen test files are touched.
  - **Widen `GitHubCliConfigSource` so the source also answers which binary to run.**
    - Pros: rides on the argument 0390 already threads to most callers.
    - Cons: the storage would have to learn about the toolchain, or every caller builds a composite source.

### 4. Move the host model catalogue seed state

**Problem.** `failedAt`, `generations` and `flights` (`host-model-catalog-seed.ts:23-25`) are keyed by platform (and project, for OpenCode) only. Two backends share one seed flight and one failure cooldown: the second backend joins the first's download, which writes the first backend's storage, so the second never gets a catalogue until its cooldown passes.

**Context.** The ticket that ran tasks 1 and 2 said to leave account code alone while another build changes it.

**Investigation.** `seedHostModelCatalogIfMissing` takes a `CommandContext` already (callers: `commands-registry-projects.ts:671` and `:764`, `agent-accounts.ts:474`). `resetHostModelCatalogSeedCooldown(agent)` takes none; its only production caller is `agent-accounts.ts:473`, which has a context in reach. `__testing.reset()` is used by four test files.

**Decisions.**

- **Where does the seed state live?**
  - **A `HostCatalogSeeds` owner on the runtime (`runtime.localServers` or a new `runtime.catalogSeeds`), with the reset taking the context; drop `__testing.reset()` (recommended).**
    - Pros: follows the runtime rules; the reset reaches the backend that signed in.
    - Cons: needs the one-line `agent-accounts.ts` change, so it waits for the account build to land.
  - **Key the maps by data directory as well.**
    - Pros: no signature change outside the module.
    - Cons: the reset still has no data directory, so it would clear every backend's cooldown.

### 5. Move the worker tab close admission

**Problem.** `closing` and `pending` (`worker-tab-close-admission.ts:7-8`) are keyed by node, environment and tab. Two backends whose ids collide (tests, or two backends over one data directory) refuse each other's tab closes and delegations.

**Context.** The admission fences a coordinator tab close against a delegation being persisted. One side is the coordinator store itself.

**Investigation.** `beginWorkerTabDelegation` is called from `storage-coordinators.ts:567` (`openCoordinatorDelegation`, which has no runtime) and `commands-registry-coordinator-nodes.ts` (two calls, with a context); `beginWorkerTabClose` from `coordinator-surface-actions.ts` and `worker-surface-runs.ts`. `openCoordinatorDelegation` has five production callers, all with a context, and 17 test calls.

**Decisions.**

- **How does the store reach a per-backend admission?**
  - **Hold it on `runtime.coordinatorRequests` (`CoordinatorRequestFlights`) and pass it to `openCoordinatorDelegation` as an argument (recommended).**
    - Pros: the runtime owns it like the other coordinator flights; the store stays free of runtime state.
    - Cons: five production calls and 17 test calls change.
  - **Let the coordinator store (`CoordinatorsRepository`) own it.**
    - Pros: no store signature change; one storage instance per backend.
    - Cons: in-memory backend state on the storage layer; the command paths reach it through `context.storage`.

## Current state

Paths are under `apps/backend/src/core/`. Line numbers were at `931e5541`.

| Module | State | Decision |
| --- | --- | --- |
| `github-cli-binary.ts` | `managedGitHubCli` (`:13`), set by `setManagedGitHubCli` from `index.ts` | Per backend: from the backend's data directory and channel. Not moved yet (task 3). |
| `host-model-catalog-seed.ts` | `failedAt`, `generations`, `flights` (`:19-21`) | Per backend: keyed by platform only. Not moved yet (task 4). |
| `container-lifecycle-service.ts` | `activeOperations` (`:64`), `operationClocks` (`:72`), `ownedByLabel` (`:609`) | Stays: the first two are keyed by the Docker owner namespace of the data directory; `ownedByLabel` memoises an immutable container label. |
| `container-network.ts` | `applyQueue` (`:475`) | Moved to `runtime.environments` (`enqueueAllowedDomainsApply`). |
| `container-network-owner.ts` | `networkOwners` (`:12`) | Stays: a container's network mode is a fact about the daemon. |
| `container-readiness.ts` | `drainingEnvironments`, `drainingContainers` (`:320-321`) | Environments moved to `runtime.environments` (`beginDrain`, `isDraining`); containers stay, since a container id names one Docker container. |
| `container-replacement.ts` | `cancellationRequests` (`:122`) | Moved to `runtime.environments` (`requestReplacementCancellation`). |
| `environment-cleanup-ledger.ts` | `connections` (`:183`), `ledgers` (`:362`), `sweepStates` (`:466`) | Stays: keyed by the resolved data directory. |
| `environment-cleanup-reconciler.ts` | `exhaustedWarnings` (`:64`), `loggedSweepFailures`, `reportedStrayWithContent` (`:627-628`), `scheduled` (`:700`) | Stays: two only de-duplicate log lines; two are keyed by the data directory. |
| `project-home-environment.ts` | `ensureTasks` (`:52`) | Moved to `runtime.environments` (`joinProjectHomeEnsure`). |
| `bug-report-service.ts` | `filingFlights` (`:319`) | Stays: keyed by data directory and report. |
| `agents-md-pr.ts` | `running` (`:254`) | Moved to `runtime.coordinatorRequests` (`joinAgentsMdPullRequest`). |
| `coordinator-action-scope.ts` | `inFlightReceipts` (`:110`) | Moved to `runtime.coordinatorRequests` (`receiptAttempt`, `trackReceiptAttempt`). |
| `worker-tab-close-admission.ts` | `closing`, `pending` (`:2-3`) | Per backend: keyed by storage ids. Not moved yet (task 5). |
| `opencode-coordinator-research.ts` | `researchToolIds` (`:22`), `registrations` (`:29`) | Moved to `runtime.localServers.openCodeAgentTools.research` (`OpenCodeCoordinatorResearch`). |
| `graph-system-action.ts` | `effectLocks` (`:116`) | Moved to the system executor's `GraphSystemActionMemory`. |
| `graph-system-checks.ts` | `readFailures` (`:118`) | Moved to the system executor's `GraphSystemActionMemory`. |
| `git-fsmonitor.ts` | `fsmonitorMigrations` (`:46`) | Stays: keyed by worktree path, and it edits that worktree's file on the host. |
| `shell.ts` | `commandInvocations` (`:127`), `commandObservers` (`:134`) | Stays: counts this process's subprocesses; `runCommand` has no backend in reach. |
| `transcript-artifacts/preview-supervisor.ts` | `backendStartIdentity` (`:142`) | Stays: the start identity of this process. |
| `transcript-artifacts/dependency-manifest.ts` | `cache` (`:215`) | Stays: verified bytes of a pinned file. |
| `control-mcp-direct-tools.ts` | `compiled` (`:84`) | Stays: compiled from constant schemas. |

## Constraints and rationale

The same as 0390: one class per owner with private state, reached through `context.runtime` at call time; behaviour stays the same.

## Needs verification

None. Production runs one backend per process and nothing here changes behaviour there; the cases in `backend-runtime-module-state.test.ts` are the proof for the moved rows.

## Assumptions and decisions

Re-checked against `main` at `93b99bfb` (2026-11-01) before starting. Every row was still module state; only line numbers had moved (`agents-md-pr.ts` `running` is at `:262`, `container-network.ts` `applyQueue` at `:478`).

### Task 1: the sorting rule

Followed the recommendation. A row stays process-wide when its key is a data directory, a host or Docker resource (a container id, a worktree path, a pinned file), the process itself, or a constant; and when it only de-duplicates a log line. A row moves when it is keyed by ids from a backend's own storage (environment, project, operation, coordinator, request and graph run ids). Such ids are random in production, but two backends over one data directory, or test fixtures, share them, and 0133 and 0390 already moved state keyed the same way (`EnvironmentOperations`, `IntegrationLocks`). Every staying row is marked next to its declaration and in the table in `backend-runtime.md`.

### Task 1: draining containers stay, draining environments move

The two sets were one fence. They are now split: an environment's drain is per backend, but a container being stopped refuses new work whichever backend asks, as before.

### Task 1: the AGENTS.md run and the receipt attempts move

Both could be argued process-wide (the AGENTS.md key names a branch on the remote; a shared receipt attempt only delays the other backend, which then re-runs against its own store). They move because their keys come from a backend's own requests, and a shared AGENTS.md run would hand one backend the result of a run against the other's checkout.

### Task 2: the owners

- `EnvironmentOperations` (`runtime.environments`) gained the project-home ensures, the allowlist apply queue, the draining environments and the replacement cancellations. `ensureProjectHomeEnvironment` and `withEnvironmentDraining` take it as their first argument; `projectHomeTesting.reset()` is gone, and `isEnvironmentDraining`, which had no caller, went with it.
- A new `CoordinatorRequestFlights` (`runtime.coordinatorRequests`) holds the receipt attempts and the AGENTS.md runs. `openAgentsMdPullRequest` takes it as its first argument.
- `OpenCodeCoordinatorResearch` replaces the five module functions and is held by the backend's `OpenCodeAgentToolsReconciler` as `research`, because the reconciler already forgot research registrations on cancellation and shutdown with the same keys. Providers reach it through a new optional `NativeAgentProviderEnvironment.openCodeCoordinatorResearch`, set from `NativeAgentService`'s option of the same name; `index.ts` passes the runtime's. A service built without it gives coordinators no research tools, which is what an empty registry gave before.

### Task 2: graph memory on the executor, not the runtime

Departed from "onto `BackendRuntime`". The graph engine does not hold `context.runtime`, and `GraphNodeSystemExecutor` is already built once per backend (`index.ts`) and owns the jobs and watches, so `GraphSystemActionMemory` lives there. A test that built a second executor to simulate a restart would now start with empty memory, as a real restart does; none relied on sharing it.

### Task 2: test contexts

Test contexts that reach a coordinator receipt and were built without a runtime gained one (a fresh `BackendRuntime`, or a partial runtime with `coordinatorRequests` where the file already used a partial one). The two-backend cases are in a new `backend-runtime-module-state.test.ts`, beside `backend-runtime.test.ts`, so concurrent changes to that file do not collide.

### Tasks 3 to 5: left for later

Three per-backend rows were not moved, to keep this change reviewable and away from account code: the GitHub CLI binary has 16 call sites in 10 modules and six test files that set it, the catalogue seed reset is called from `agent-accounts.ts`, and the tab close admission is taken inside the coordinator store. Each is marked next to its declaration and listed in `backend-runtime.md`.

## Related

- [0390-backend-module-state-beyond-0133.md](0390-backend-module-state-beyond-0133.md)
- [`backend-runtime.md`](../../architecture/backend-runtime.md)
