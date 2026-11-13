---
id: 3014
title: "Per-scope services and startup"
phase: 3
plan: "§7.4 and §12 Phase 3.7"
status: done
depends_on: [3001]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3014 · Per-scope services and startup

- **Report:** [§7.4 Services and module state](../../docs/reports/unified-federation.md#74-services-and-module-state), [Appendix B](../../docs/reports/unified-federation.md#appendix-b-module-singletons)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md)
- **Blocks:** [4001](4001-in-tree-workspace-seam.md), [4002](4002-hydration-tiers-and-budgets.md)
- **Parallel with:** the store items, each of which moves its own handlers here
- **Size:** M
- **Track:** S (scopes)

## Goal

What `App.tsx` starts once for the one backend is started per scope, at the tier that needs it, and each service has an explicit stop (invariant 15).

## Current state (verified 2026-11-07)

`App.tsx` (1,761 LOC) :355-369. The report says :353-365 and omits `startDataSavingReadPolicy`.

| Line | Call | Stop |
|---|---|---|
| 355-363 | `startResourceSync({…})` (`lib/resource-sync.ts:279`, 606 LOC, 7 singletons) | returns stop |
| 364 | `startStoreResourceSync()` (`store-resource-sync.ts:105`, 703 LOC, 35 sites) | yes |
| 365 | `startTransportConnectivity()` (`transport-connectivity.ts:102`, 125 LOC) | yes; no-op without `eventStreamConnection` |
| 366 | `startDataSavingReadPolicy()` (`lib/data-saving.ts:14`) | yes |
| 367 | `startPaneLayoutPersistence()` | yes |
| 369 | `startBuildPipelineCompletionNotes()` | yes |

Also: `migrateLegacyBuildPipelines` (:370), `startCoordinatedPoll` (:701), and `useHydrateOncePerEnvironment` for prompt queues and Multi Review.

`read-coordinator.ts` (1,186 LOC, 3 singletons) is shared: visibility and data-saving policy belong to the window, and reconnect bookkeeping belongs to each node.

## Work

- [x] Define each started service with `defineScopedService`. Start them for the command scope at the same point in `App.tsx`. A later "warm" scope starts the light ones; see the tier table in [4002](4002-hydration-tiers-and-budgets.md).
- [x] `store-resource-sync`: split into per-store handler registrations that run inside the scope. Each store item moves its handlers here; this item provides the mechanism and moves the remainder.
- [x] `transport-connectivity`: per node, plus a window aggregate for the title bar.
- [x] `read-coordinator`: the window part (visibility, `setHostHidden` from [0003](0003-hidden-realm-visibility.md), data saving) stays a singleton. Per-node reconnect state moves onto the scope.
- [x] `startCoordinatedPoll` and the hydrate-once hooks: per scope.
- [x] Every service handles rejection on its scope's `AbortSignal` (§10.3).

## Tests

- [x] Each service: start, stop and restart, with no timer or listener left after stop (checked in `afterEach`).
- [x] A failing service marks only its scope as failed.

## Done when

- [x] `App.tsx` starts services only through the command scope, and the module `start*` singletons are gone or explicitly window-level.

## Notes

- **API (2026-11-07).**
  - `lib/scope-services.ts` (new): `resourceSyncService`, `scopeResourceSyncOptions(scope)` (the app command scope keeps the `@/lib/backend` manifest reads, which suites mock; any other scope sends the same three commands through `invokeInScope` with the same response checks), `WARM_SCOPE_SERVICES` (resource-sync, store-resource-sync, transport-connectivity), `COMMAND_SCOPE_SERVICES` (those plus data-saving, pane-layout persistence, completion notes), `startScopeServices(scope, services) → stop` (starts in order, reuses a running handle, stops in reverse; a failed start marks the scope failed and the rest still start).
  - Service defs, each in its own module: `storeResourceSyncService`, `transportConnectivityService`, `dataSavingReadPolicyService`, `paneLayoutPersistenceService`, `buildPipelineCompletionNotesService`. The last three throw on a non-command scope (that marks the scope failed; it is a programming error, since the warm set never lists them). *(2026-11-07, orchestrator, completeness check: stale for two of them. [3013](3013-pane-layout-store.md) (`e1db40961`) added `paneLayoutPersistenceService` and `buildPipelineCompletionNotesService` to `WARM_SCOPE_SERVICES`, and [4003](4003-snapshot-first-rehydration.md) (`be31b3358`) added `nodeSnapshotService`; the warm set is now resource sync, store resource sync, transport connectivity, pane-layout persistence, completion notes and node snapshots. Only `dataSavingReadPolicyService` (with window-selection persistence) stays command-scope only.)*
  - `lib/read-window-policy.ts` (new, the window part): `createReadWindowPolicy({ document, window })`, `getReadWindowPolicy()`, `resetReadWindowPolicyForTests(policy?)`; `ReadWindowPolicy { isHidden, hostHidden, dataSaving, setHostHidden, setDataSaving, subscribe, dispose }`, events `visibility | data-saving | hint(resume|reconnect)`.
  - `lib/read-coordinator.ts` (the node part): `createReadCoordinator({ policy? })` follows a shared policy (without one it builds and owns a private one from `document`/`window`, so existing callers are unchanged); `ReadCoordinator.policy`; `setDataSaving`/`setHostHidden` forward to the policy (window-wide). `readCoordinatorFor(scope)` (one per node scope, over the window policy, disposed with the scope; throws for a disposed scope), `getReadCoordinator()` = the command scope's, `notifyReadCoordinatorReconnected(scope?)`, `setReadCoordinatorConnection(id, scope?)`, `setReadCoordinatorDataSaving` (the window policy), `resetReadCoordinatorForTests(factory?, policy?)`. `installFakeReadCoordinator` installs its fake's policy as the window's.
  - `lib/resource-sync.ts`: one change feed per scope (handlers, resync and view-safety handlers, coalescing timers, transports) in a `defineScopedSlot` slot cleared on dispose. Every export takes an optional trailing `scope` (default command scope): `onResourceChanged`, `onResourceResync`, `onViewSafetyCheck`, `requestViewSafetyChecks`, `requestResourceResync`, `dispatchResourceChange`, `resetResourceSync`, `startResourceSync(options, scope)`. The transport listens through `listenInScope`, primes `scope.prefetched`, and forwards reconnects to the scope's coordinator.
  - `lib/store-resource-sync.ts`: `defineStoreResourceHandlers(name, runsOn: "command-scope" | "every-scope", register)`, `StoreResourceSyncContext { scope, signal, options, disposed(), onResourceChanged, onResync(phase, participant), listen, onStop, requestResync }`, phases `projects → environments` (serial) `→ dependents` (concurrent) `→ layouts`, `StoreResyncPass { includes, requeue }`, `STORE_RESOURCE_HANDLERS` (projects, environments, config, agent-mail, prompt-queues, sessions, workflows, kanban, feature-plan, pane-layout), `storeResourceHandlersFor(scope)`, `startStoreResourceSync(options, { scope?, handlers?, signal? })`. The resync failure events (`resync.project-failed`, `…environment-failed`, `…read-failed`, `…pane-failed`) are logged per phase exactly as before.
  - `lib/transport-connectivity.ts`: per-node state in a scoped store (`setTransportDisconnected(source, down, scope?)`, `getNodeConnectivity(scope)`, `subscribeNodeConnectivity(scope, l)`), a node's change reaching only its own coordinator; window aggregate `getTransportConnectivity()` / `useTransportConnectivity()` (disconnected while any open node is, since the earliest outage; a disposed node drops out). `startTransportConnectivity(source?, scope?)`: the app command scope reads the gateway's raw stream state; any other scope its client's `connection` (`lapsed`/`failed` are outages).
  - `lib/pane-layout-persistence.ts`: the enqueue/adopt pair and the write-settled handlers moved from module `let`s into a per-scope slot; `onPaneLayoutWriteSettled`, `adoptPersistedPaneLayout`, `flushPaneLayoutNow`, `migratePaneLayoutBrowserHistory` and `startPaneLayoutPersistence` take an optional trailing scope. `build-pipeline-completion-notes.ts`: the pending-notes map moved into each watcher.
  - `startCoordinatedPoll({ …, scope? })` schedules on that scope's coordinator. `useHydrateOncePerEnvironment(environments, hydrate, onError, scope?)` keeps one restored set per scope (default the nearest provider's); `hydrate` closes over its scope rather than receiving it, so a reader with an optional second parameter (`hydrateBootMultiReviewWorkflows(id, batcher)`) can still be passed directly.
  - `App.tsx`: `useEffect(() => startScopeServices(commandScope, COMMAND_SCOPE_SERVICES), [commandScope])` at the old start point; the connection list sets the command scope's connection and connectivity explicitly; the Docker poll names the command scope; both hydrate-once hooks pass it.
- **Decision: what stays window-level (2026-11-07).** Visibility, host-hidden, data saving and the focus/pageshow/online hints are the window's (`ReadWindowPolicy`); entries, connection identity, connectivity and reconnect reconciles are per node. Options for the split: (a) one coordinator with node-qualified keys and per-node pause flags; (b) a coordinator per scope over a shared window policy. Chosen (b): the engine is unchanged (only its inputs moved), a node's reconnect cannot reset another node's backoff, and disposing a scope disposes exactly its reads. The cost is one timer grid per node, which the per-key timers already were. `dataSavingReadPolicyService` is window-level and runs on the command scope (which lives as long as the window); started elsewhere it throws, as a second writer of one window value.
- **Decision: who starts and stops the command scope's services (2026-11-07).** Options: (a) start in `App` and never stop (strict "unmount is not cancel"); (b) start in `App` and stop on `App` unmount; (c) start when the window scope is created. Chosen (b): `App` is the command scope's lifecycle owner until 4002's manager, it unmounts only with the window, the order relative to React-mounted subscribers is today's, and App suites rely on the stop. Disposing the scope also stops them.
- **Decision: command-scope-only registrations (2026-11-07).** Every current store binding writes a store that is still a command-scope singleton, so each is `command-scope`. A leaf scope's `store-resource-sync` therefore runs no registration today (only its own resync loop), which is the safe default: started for another node, the old bindings would write that node's data into the command node's stores. Each store item moves its registration into its store module, reads `context.scope.store(def)`, and marks it `every-scope` (recipe in `docs/development/node-scopes.md`, "Services, change feeds and reads per scope").
- **Rejection on the abort signal (§10.3).** No service hands its `AbortSignal` to work that rejects on abort today: resource-sync's manifest loop and the store bindings check their own `disposed` flag after every await, as before, and their reads catch and log. `StoreResourceSyncContext.signal` is the service's signal for registrations that will pass it to reads. Tests stop and dispose every service with no unhandled rejection (bun fails a test on one).
- **Where Effect is used, and where not (2026-11-07).** Used through 2001's `Lifetime`: each running service is a child Effect `Scope` of its node scope, every slot here (feed, coordinator, connectivity, pane-layout persistence) is cleaned by an `onDispose` finalizer on that Effect-backed lifetime, and a scope's disposal order (services, then slots, then stores, budgets, client) comes from Effect. Not used: the service list is a plain ordered array, not a `Layer` (the services provide nothing to each other through a context and need only a start order; React starts them synchronously); the read policy and per-node state are small synchronous structures React reads directly; no `Schedule`, because the coordinator's own backoff and the resource manifest interval are unchanged.
- **Behaviour changes (2026-11-07).** (1) `resetWindowScopeForTests()` now also drops the command scope's change-feed handlers, coordinator, connectivity and pane-layout hooks (they live on the scope). (2) A test-installed coordinator factory applies only to the app's command scope. (3) The connectivity aggregate counts every open node of the app window; with only the command scope it is today's value. (4) The deferred workflow reads still follow `document.visibilityState`, not the policy's host-hidden override (0003's list of direct checks is unchanged).
- **Not changed, deliberately.** `migrateLegacyBuildPipelines` stays a one-shot effect in `App` (a migration, not a service; removed on 2026-11-13 by [7571](../../docs/todo/cross-cutting/7571-removal-candidates-needing-a-decision.md) task 8). The hook-based monitors `App` mounts (`usePrMonitorService`, `useGlobalActivityMonitor`, `useNotificationSoundService`, `useEnvironmentLifecycleService`, `useUnreadEnvironmentSync`) are not in this item's inventory and stay hooks. `WorkspaceRealmHost` still calls `getReadCoordinator().setHostHidden`, which now sets the window policy (window-wide, as intended).
- **Done when.** The six `start*` calls are gone from `App.tsx`; it starts `COMMAND_SCOPE_SERVICES` through the command scope. Module singletons: resource-sync's handler maps, connectivity, read-coordinator state, pane-layout persistence's enqueue/adopt and write-settled handlers and the completion notes' map are per scope or per watcher; window-level and named so: `ReadWindowPolicy`, the connectivity aggregate's listeners and clock, `startCoordinatedPoll`'s instance counter, the data-saving service. The `start*` functions remain as the bodies the services call (and tests drive).
- **For the orchestrator.** (1) Plan item 3004 is converting `environmentStore`/`projectStore` to the shim at the same time: its `scoped-store-shim` baseline must be regenerated after this commit, since `store-resource-sync.ts` moved its shim uses between registrations (the guard currently counts 12 `[environment]` and 4 `[project]` uses there). Its own `store-resource-sync.test.ts` failure (`invalidateProjectSnapshots` removed) is 3004's. (2) Report §7.4 can name the split: `read-window-policy.ts` (window) and `readCoordinatorFor(scope)` (node); `scope-services.ts` holds the service list; `store-resource-sync`'s per-store registrations are the mechanism store items move their handlers onto. (3) 4002 starts `WARM_SCOPE_SERVICES` for warm scopes and owns the stop on suspend; 5002 can show `useTransportConnectivity()` (aggregate) or `getNodeConnectivity(scope)` in the title bar.
- **Aggregate suite** left to review preparation.

## Work log

- 2026-11-07 (claude-worker): six `App.tsx` services as scoped services started for the command scope through `startScopeServices`; read coordinator split into `read-window-policy.ts` and per-scope coordinators; per-scope change feeds in `resource-sync`; `store-resource-sync` rebuilt as per-store handler registrations with resync phases; per-node connectivity with a window aggregate; pane-layout persistence hooks and completion notes per scope/watcher; scoped `startCoordinatedPoll` and hydrate-once; recipe section in `docs/development/node-scopes.md`. New tests: `scope-services.test.ts` (start/stop/restart of each of the six with a leftover tracker for timers, DOM listeners, store subscriptions, client events and connection subscriptions checked after stop and in `afterEach`; dispose stops all; failure isolation for a throwing start and a rejecting `done`; per-node feeds; registration phases, requeue and failure logging; per-node coordinators), per-node/aggregate connectivity, scoped poll, per-scope hydrate-once. Focused runs: `src/lib src/hooks src/stores App.test.tsx` pass; `src/components` failures only in suites other agents are editing (files panel, terminal portal, project store, NodeClient interface); `tests/unit/source-guards.test.ts` fails only on 3004's uncommitted shim-store findings. `tsc` errors only in other agents' in-flight files and in tests through their `FakeNodeClient`/`NodeClient` change; fmt and oxlint clean on touched files.
- 2026-11-07 (orchestrator, completeness check): marked the warm-set note stale: `WARM_SCOPE_SERVICES` now includes pane-layout persistence and completion notes (3013) and node snapshots (4003).
