# Backend module state beyond 0390

Found while doing [0390](0390-backend-module-state-beyond-0133.md) on
`todo-0390-backend-module-state-2ae5bfedeb60`. A scan of `apps/backend/src/core`
for module-level `let`s and `Map`/`Set` singletons turned up more state that
0390's table did not list. Two backends in one process may share it.

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`.

### Tasks

1. **Sort the remaining module state**: decide, per row of Current state, whether it moves onto `BackendRuntime` or stays process-wide and documented. Status: open.
2. **Move the per-backend rows**: move what task 1 marks per-backend, with a two-backend case for each. Status: open (depends on 1).

### 1. Sort the remaining module state

**Problem.** The rows below are module state that is neither on `BackendRuntime` nor in the "Process-wide on purpose" table, so nothing says whether two backends may share them.

**Context.** [`backend-runtime.md`](../../architecture/backend-runtime.md) holds the rules and the table. Production runs one backend per process, so none of this changes shipped behaviour.

**Investigation.** The scan matched declarations only. No row has been read for its keys or its callers, so a row may already be isolated by a data-directory key, as the OpenCode journals were in 0390. Excluded: constant lookup sets, `WeakMap`s keyed by an owning object, and embedded worker scripts, whose state lives in their own process.

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

**Investigation.** Not started; it depends on task 1. `github-cli-binary.ts` is imported by modules that hold no context, and `gitHubCli()` is called next to every `gitHubCliEnv` call, so the source argument 0390 added reaches most of its callers already.

**Decisions.**

- **How to split the work?**
  - **One commit per owner, on one branch per reviewable group (recommended).**
    - Pros: each diff has one subject; matches 0390.
    - Cons: several branches over time.
  - **One branch for everything.**
    - Pros: done in one go.
    - Cons: too large to review.

## Current state

Paths are under `apps/backend/src/core/`. Line numbers are at `931e5541`.

| Module | State |
| --- | --- |
| `github-cli-binary.ts` | `managedGitHubCli` (`:13`), set by `setManagedGitHubCli` from `index.ts` |
| `host-model-catalog-seed.ts` | `failedAt`, `generations`, `flights` (`:19-21`) |
| `container-lifecycle-service.ts` | `activeOperations` (`:64`), `operationClocks` (`:72`), `ownedByLabel` (`:609`) |
| `container-network.ts` | `applyQueue` (`:475`) |
| `container-network-owner.ts` | `networkOwners` (`:12`) |
| `container-readiness.ts` | `drainingEnvironments`, `drainingContainers` (`:320-321`) |
| `container-replacement.ts` | `cancellationRequests` (`:122`) |
| `environment-cleanup-ledger.ts` | `connections` (`:183`), `ledgers` (`:362`), `sweepStates` (`:466`) |
| `environment-cleanup-reconciler.ts` | `exhaustedWarnings` (`:64`), `loggedSweepFailures`, `reportedStrayWithContent` (`:627-628`), `scheduled` (`:700`) |
| `project-home-environment.ts` | `ensureTasks` (`:52`) |
| `bug-report-service.ts` | `filingFlights` (`:319`) |
| `agents-md-pr.ts` | `running` (`:254`) |
| `coordinator-action-scope.ts` | `inFlightReceipts` (`:110`) |
| `worker-tab-close-admission.ts` | `closing`, `pending` (`:2-3`) |
| `opencode-coordinator-research.ts` | `researchToolIds` (`:22`), `registrations` (`:29`) |
| `graph-system-action.ts` | `effectLocks` (`:116`) |
| `graph-system-checks.ts` | `readFailures` (`:118`) |
| `git-fsmonitor.ts` | `fsmonitorMigrations` (`:46`) |
| `shell.ts` | `commandInvocations` (`:127`), `commandObservers` (`:134`) |
| `transcript-artifacts/preview-supervisor.ts` | `backendStartIdentity` (`:142`) |
| `transcript-artifacts/dependency-manifest.ts` | `cache` (`:215`) |
| `control-mcp-direct-tools.ts` | `compiled` (`:84`) |

## Constraints and rationale

The same as 0390: one class per owner with private state, reached through `context.runtime` at call time; behaviour stays the same.

## Related

- [0390-backend-module-state-beyond-0133.md](0390-backend-module-state-beyond-0133.md)
- [`backend-runtime.md`](../../architecture/backend-runtime.md)
