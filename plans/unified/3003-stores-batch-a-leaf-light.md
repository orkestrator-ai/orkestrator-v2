---
id: 3003
title: "Convert the light per-node stores (batch A)"
phase: 3
plan: "§12 Phase 3.1"
status: done
depends_on: [3001, 3002]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3003 · Convert the light per-node stores (batch A)

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan), [Appendix A](../../docs/reports/unified-federation.md#appendix-a-store-classification)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md), [3002](3002-lib-backend-client-parameter.md)
- **Parallel with:** [3004](3004-project-and-environment-stores.md), [3005](3005-config-layering.md), [3011](3011-workflow-stores-a.md), [3012](3012-workflow-stores-b.md) and the other independent store items
- **Size:** M (one PR per store or a pair)
- **Track:** S (scopes)

## Goal

Convert the stores with the fewest imperative sites, to settle the recipe and the test helper.

## Stores (LOC, imperative sites total/in `.ts`; verified 2026-11-07)

| Store | LOC | Imperative sites (total/`.ts`) | Notes |
|---|---|---|---|
| `environmentDiffStore` | 84 | 0 | |
| `worktreeSnapshotStore` | 121 | 0 | |
| `agentActivityStore` | 62 | 0 | |
| `prMonitorStore` | 102 | 2 | |
| `multiReviewStore` | 30 | 19/13 | includes `multi-review-persistence.ts` (182 LOC, 2 module singletons) |
| `agentModelCatalogStore` | 95 | 14/13 | includes `agent-model-catalog-cache.ts` (11 sites) |
| `claudeOptionsStore` | 41 | 1 | already done in [3001](3001-scoped-store-shim-and-ratchet.md) |
| `tabLaunchStore` | 105 | 9/9 | includes `tab-launch.ts` (165 LOC, 3 module singletons) |

## Work

For each store:

- [x] Change the definition to `defineScopedStore`, with backend calls through `createXApi(scope.client)`.
- [x] Move imperative sites whose scope is known to `scope.store(def)`; leave the rest on the shim.
- [x] Turn module singletons in the companion modules into `defineScopedService` or into state on the scope.
- [x] Switch the stores' own tests and the companion modules' tests to explicit scopes (`WindowScope` + `FakeNodeClient`, `renderInNodeScope` for the hook).
- [x] Switch the readers' component suites (`ActionBar`, `TerminalContainer.*`, `PaneLeafContainer`, `DraggableTabBar`, `MultiReview*`, `AgentNativeTab`, `CreateEnvironmentDialog`, sidebar) to `renderInNodeScope`, so each hook can retire its shim (`useScopedStore`).
- [x] Update the shim baseline.

## Tests

- [x] Per store: two scopes keep independent state, the hook reads the rendered scope, and the deprecated statics reach the command scope.
- [x] Every backend call the batch's modules make goes to the scope's client (multi-review reads and the legacy launch, the model-catalogue cache read; the stores themselves make none).
- [x] The mirror stores' writers (`useEnvironmentDiffStats`, `useWorktreeSnapshotRevisions`, `usePrMonitorService`) read and listen through the scope's client, with a test.

## Done when

- [x] Every store in the batch is converted, and the batch's shim count is recorded in Notes (target 0 for these; 2 remain, see Notes).

## Notes

- **Stores converted (2026-11-07).** All eight are `defineScopedStore<S>(name, () => creator)` plus `useXStore = scopedStoreHook(def)`, registered in `SHIMMED_STORES` and exported (def beside hook) from `@/stores`: `environment-diff`, `worktree-snapshot`, `agent-activity`, `pr-monitor`, `multi-review`, `agent-model-catalog`, `tab-launch`, and `claude-options` (3001's, verified unchanged). `tabLaunchStore` and `worktreeSnapshotStore` were not in the barrel; they are now, because the guard's barrel test expects every shimmed store there. The state interfaces are exported for tests and helpers. No store creator makes a backend call, so none needed `createXApi`.
- **Shim totals (`scoped-store-shim`, 2026-11-07): 2 in 1 file.** `multi-review`: 2 in `lib/pane-layout-authoritative.ts` (`hydratePaneLayoutDependencies` and `reconcileAuthoritativePaneLayout`, plain code reached from pane-layout persistence with no scope; plan item 3013 threads one). `claude-options`: 0 (the `App.tsx` site now uses 3014's `commandScope`). `environment-diff`, `worktree-snapshot`, `agent-activity`, `pr-monitor`, `agent-model-catalog`, `tab-launch`: 0. `lib-backend-command-default`: 0 for the batch's modules.
- **Imperative sites moved.** Components and hooks use 3007's `useScopedStoreApi(def)` / `useShimNodeScope(def.name)` (they note a shim use when no provider is above them, so 4004 sees it), because their suites still render without a provider and `useNodeScope()` throws there: `TerminalContainer.view`, `DraggableTabBar`, `PaneLeafContainer`, `TabLaunchShimmer`, `MultiReviewTab`, `AgentNativeTab.controller` / `.helpers`, `ClaudeTmuxChatTab`, `CreateEnvironmentDialog`, `DesignWorkspaceDialog`. `useActionBarController` uses its existing `actionBarScope`; `App.tsx` uses `commandScope`. `buildReviewModelCatalog(models)` lost its `= useAgentModelCatalogStore.getState()` default (a hidden static); its callers pass their scope's state or their hook selections (which also lets two `react-hooks/exhaustive-deps` suppressions go; `useBuildLaunchOptions` then needed a `react/set-state-in-effect` suppression for a pre-existing reset, because React Compiler analysis had been skipped while the file held a react-hooks suppression). `syncCachedAcpModels(scope, models)` takes its scope first.
- **Companion modules.**
  - `multi-review-persistence.ts`: the unavailable markers and the reads in flight (its 2 module singletons) are one `defineScopedSlot("multi-review-persistence")`. Every export takes an optional trailing `scope` (`hydrateMultiReviewWorkflow(id, scope?)`, `hydrateMultiReviewWorkflowsForEnvironment(id, scope?)`, `applyMultiReviewWorkflowsForEnvironment(id, entries, scope?)`, `findActiveMultiReviewWorkflow(id, scope?)`, `isMultiReviewWorkflowKnownUnavailable(id, scope?)`, `resetMultiReviewPersistenceForTests(scope?)`). Reads go through `backendApiForScope(scope, createWorkflowsApi, { … })`, so the command scope keeps the mocked named exports and any other scope reaches its own client. The store and slot are read before each `await`.
  - `tab-launch.ts`: the arrival timers, the layout watch and the double-press claims (its 3 module singletons) are one `defineScopedSlot("tab-launches")` whose `scope.onDispose` clears every timer and stops the watch (invariant 15). The claim release timer is now tracked so dispose clears it. `beginTabLaunch`, `cancelTabLaunchFocus`, `focusTabLaunch`, `claimTabLaunch` and `resetTabLaunches` take an optional trailing `scope`. The pane layout it watches is still the command scope's singleton (3013).
  - `agent-model-catalog-cache.ts`: `hydrateAgentModelCatalogCache({ seed?, scope? })` reads the scope's node (`backendApiForScope(scope, createConfigIntegrationsApi, …)`) into that scope's store. It had no module state, only its 11 sites.
  - `multi-review-launch-compat.ts`: `LegacyMultiReviewLaunchInput.scope` (required); start, cancel and delete go to that scope's node, and the workflow lands in that scope's store. It imports `multiReviewStore` through `@/stores`, as it did the hook, so `ActionBar.test.tsx`'s barrel mock (now a test-only def whose actions are its mocks) still sees the writes.
- **Decision: optional trailing `scope` on the companions (2026-11-07).** Options: (a) required `scope` everywhere: every remaining caller without a scope (`store-resource-sync.ts`, `boot-hydration.ts`, `pane-layout-authoritative.ts`, `app-startup.ts`, the settings refresh) and about 60 test calls would change in files other items own this wave; (b) optional trailing `scope`, defaulting to the app's command scope, the convention 3014 (`resource-sync.ts`, `pane-layout-persistence.ts`) and 3016 (slots) already use. Chosen: (b); every production caller that has a scope passes it. The defaults are not counted by the `scoped-store-shim` guard. The production callers that still rely on them: `store-resource-sync.ts` (the `workflows` registration, command scope only), `boot-hydration.ts`, `pane-layout-authoritative.ts`, `app-startup.ts`, `components/settings/agent/refresh-model-catalog.ts`.
- **`store-resource-sync` (3014 landed in d6c5a5602).** Multi Review's change and resync handlers stay in the shared `workflows` registration, `command-scope`. Splitting them into an `every-scope` registration needs (1) the build-pipeline half, which shares the hidden-window deferral, overflow resync and retry timer with it, converted by 3011, and (2) the resync's environment list read from `context.scope.store(environmentStore)` (3004, in progress). Recorded for 3011: when the pipeline store converts, move both halves to `every-scope` and pass `context.scope` to `hydrateMultiReviewWorkflow(s…)`.
- **The mirror stores' writers (done 2026-11-07, with 3010).** `useEnvironmentDiffStats`, `useWorktreeSnapshotRevisions` and `usePrMonitorService` read their scope with `useShimNodeScope(def.name)` and then read (`fetchEnvironmentDiffStatsView(known, scope?)`, `fetchWorktreeSnapshotRevisions(known, scope?)`, `fetchPrMonitorView(known, scope?)`, each through `backendApiForScope(scope, createFilesSessionsApi, { … })`), listen (`listenInScope`), re-read on reconnect (`onReconnectInScope`, 3010's helper in `lib/node-scope-slots.ts`) and run the safety check (`onViewSafetyCheck(cb, scope)`) on that scope's node. On the app's command scope every path is the one the suites spy on (`listen`, the named exports, `native-event-stream-connected`). On any other scope the reconnect is the client's `connection` signal going back to `live`, not the `native-event-stream-connected` event: the browser client forwards that gateway event on `listenRaw` too, but the desktop and leaf clients are not specified to, and the signal is what every `NodeClient` has (2011's `watchGenerations` uses the same transition).
- **Decision: how the readers' suites get a provider (2026-11-07).** Options: (a) `renderInNodeScope` with a fresh `WindowScope` and a `FakeNodeClient`: every suite's `@/lib/backend` mocks (about 1,700 tests across the 48 files) would stop seeing calls (`backendApiForScope` reaches the fake client on a non-app scope), and every static seed (`useXStore.setState`) would reach a different instance, so each suite would be rewritten; (b) a sibling helper, `renderInAppCommandScope(ui, options)` in `test/render-in-node-scope.tsx`, rendering under `WindowScopeProvider`/`NodeScopeProvider` for the app's own window and command scope (chosen). With (b) the components read a provider exactly as in the app (no `hook-without-provider` fallback, so the hooks can retire the shim), and the suites' mocks and seeds still apply. The suites moved: `ActionBar`, `TerminalContainer.{view,helpers,notes,render-count}`, `TerminalContainerOverlays`, `PaneLeafContainer`, `DraggableTabBar` (+ `.launch-override`), the 14 `MultiReview*` suites, the 9 `AgentNativeTab*` suites, `CreateEnvironmentDialog` and the 16 sidebar component suites (48 files, every `render(` call). `useSidebarHydration.test.tsx` renders hooks only (`renderHook`) and is unchanged. Retiring the batch's hooks to `useScopedStore` is not done here: other readers' suites (outside this list) still render without a provider, and 4004's runtime guard is what finds them. Recorded in `docs/development/testing-guide.md`.
- **Where Effect is used, and where not.** Not used. The stores are zustand creators over 2001's scope (whose lifetime is already an Effect `Scope`); the companions' state is plain maps in a slot, and their timers stop through `scope.onDispose`, which runs on the scope's Effect-backed lifetime.
- **Aggregate suite left to review preparation.** `mise run test` was not run.

## Work log

- 2026-11-07 (claude-worker): converted the eight stores (seven new, `claude-options` verified) and registered them; moved every imperative site with a known scope, including `App.tsx`'s `claude-options` site; turned the singletons of `multi-review-persistence.ts` and `tab-launch.ts` into scoped slots; scoped `agent-model-catalog-cache.ts` and `multi-review-launch-compat.ts`; removed `buildReviewModelCatalog`'s static default; added the companion-module paragraph to `docs/development/node-scopes.md`. Tests: new `stores/light-scoped-stores.test.tsx` (25: per store, two scopes, hook under `renderInNodeScope`, statics on the command scope; barrel), new `lib/multi-review-launch-compat.test.ts` (1), per-scope blocks in `multi-review-persistence.test.ts` (+3), `tab-launch.test.ts` (+3), `agent-model-catalog-cache.test.ts` (+1); `agentModelCatalogStore.test.ts` and `worktreeSnapshotStore.test.ts` now open explicit scopes. Whole web suite: 13,844 pass, 2 fail (`AppDialogHost.test.tsx`, from 3004's uncommitted `AppDialogHost.tsx`). `tests/unit/source-guards.test.ts`: 98 pass, 2 fail (the repository ratchet, on the pre-existing test-guard findings only). Web typecheck: no errors in this item's files (others' in-progress files had some). oxlint and fmt clean on the touched files.
- 2026-11-07 (claude-worker, with 3010): the three mirror hooks read, listen, re-read on reconnect and run the safety check through their scope's client; the readers' component suites (48 files) render under the app's command scope providers with the new `renderInAppCommandScope`. Tests: new `hooks/mirror-hooks.scopes.test.tsx` (4: each hook reads, listens and re-reads on its own node with the other node untouched, and unmount releases its listener; a node's diff-stat change lands in its own store only), `scoped-store-shim.test.tsx` +1 (`renderInAppCommandScope` reads what the statics seed with no fallback noted). The 48 moved suites: 1,676 pass, 0 fail with `--parallel=2`, the same as before the move; the three hooks' own suites: 18 pass. Web typecheck: no errors in these files. fmt and oxlint clean.
