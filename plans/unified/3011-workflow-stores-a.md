---
id: 3011
title: "Convert pipeline, Kanban, feature plan, coordinator and graph stores"
phase: 3
plan: "§12 Phase 3.5"
status: done
depends_on: [3004]
blocked_by: ""
owner: "claude-worker"
branch: "unified-federation-b4c9ee65814d"
pr: ""
updated: 2026-11-07
---

# 3011 · Convert pipeline, Kanban, feature plan, coordinator and graph stores

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3004](3004-project-and-environment-stores.md)
- **Parallel with:** [3012](3012-workflow-stores-b.md), [3009](3009-agent-and-transcript-stores.md)
- **Size:** L
- **Track:** S (scopes)

## Stores (verified 2026-11-07)

- `buildPipelineStore` (222 LOC). It has 46 imperative sites, but **19 are in `components/build-pipeline/build-chat-tab-test-support.tsx`**, so 27 are production code.
  - Companion modules: `build-pipeline-persistence.ts` (652 LOC, 8 singletons, 10 sites), `build-pipeline-completion-notes.ts` (started in `App.tsx:369`), `feature-build-activation.ts`.
- `kanbanStore` (305 LOC, 8/7). It calls `buildPipelineStore` (:177), so convert it after or with the pipeline store.
- `featurePlanStore` (293 LOC, 7/3)
- Coordinator stores:
  - `coordinatorActivityStore` 149
  - `coordinatorLaunchOverrideStore` 157
  - `coordinatorPaneLayoutStore` 297
- Graph stores:
  - `graphDesignerStore` 738
  - `graphRunStore` 312
  - `graphDescribeStore` 127
- `lib/coordinator-work-navigation.ts` (170 LOC, 4 singletons), `lib/prompt-queue-*`.

## Work

- [x] Convert in this order: pipeline, Kanban, feature plan, coordinator, graphs.
- [x] Turn pipeline persistence and feature-build activation into per-scope state (slots on the scope, [3014](3014-scoped-services-and-startup.md)'s and 3003's pattern), and make the completion-notes service watch its own scope's pipelines.
- [x] Run the completion-notes service on every scope. It still opens the notes tab in `paneLayoutStore`, a command-scope singleton, so it refuses a non-command scope until [3013](3013-pane-layout-store.md) scopes the pane layout. (Done in 3013: the service opens the notes in its own scope's pane layout and is in `WARM_SCOPE_SERVICES`.)
- [x] Move `build-chat-tab-test-support.tsx` to `renderInNodeScope`, which removes its 19 static calls.

## Tests

- [x] A pipeline launched on the command scope and observed from a second scope (fake) keeps independent state.
- [x] Graph designer and run view suites pass.

## Done when

- [x] All stores in this item are converted, with shim counts at target.

## Notes

- **API (2026-11-07).**
  - Stores (each `defineScopedStore<S>(name, (scope) => creator)` plus `useXStore = scopedStoreHook(def)`, registered in `SHIMMED_STORES`, def exported beside its hook from `@/stores`, state type exported): `buildPipelineStore` (`build-pipeline`), `kanbanStore` (`kanban`), `featurePlanStore` (`feature-plan`), `coordinatorActivityStore` (`coordinator-activity`), `coordinatorLaunchOverrideStore` (`coordinator-launch-override`), `coordinatorPaneLayoutStore` (`coordinator-pane-layout`), `graphDesignerStore` (`graph-designer`), `graphRunStore` (`graph-run`), `graphDescribeStore` (`graph-describe`). Actions are unchanged.
  - Reads inside the creators go through `backendApiForScope(scope, createXApi, { …named exports })`, read per call so a suite's later `mock.module` is seen: Kanban (`createKanbanApi` + `createWorkflowsApi` for `clearTaskBuildStatus`), feature plans (`createKanbanApi`), coordinator activity and overrides (`createCoordinatorApi`), coordinator layouts (`createClientStateApi`, plus `clientStateCapabilities(scope)` and the legacy browser copy under `nodeStorageKey(…, scope)`), graph runs, describe jobs and templates (`createGraphRunsApi`, `createGraphDescribeApi`, `createGraphTemplatesApi`, through namespace imports of their `lib/backend/graph-*.ts`).
  - Module state moved into each instance: the feature-plan load request counters, the graph-run reads in flight, the designer's sub-graph loads and compile contexts. The coordinator projections subscribe to their scope's feed (`onResourceChanged/onResourceResync/onViewSafetyCheck(…, scope)`) and to 3009's per-scope `subscribeNativeObservationInvalidations(listener, scope)`, and register `scope.onDispose` to stop subscriptions and the coalescing timer (invariant 15).
  - `findTaskForEnvironment(environmentId, scope)` (required scope; it had no production caller). `graphDesignerTab(tabId, scope = appCommandScope())` (test helper).
  - `lib/build-pipeline-persistence.ts`: its 7 module singletons (generation counter, three generation maps, unavailable markers, watched transcripts, reads in flight) are one `defineScopedSlot("build-pipeline-persistence")`. Optional trailing `scope` (command scope when omitted): `hydrateBuildPipeline(id, load?, options?, scope?)`, `hydrateBuildPipelinesForProject(id, list?, scope?)`, `isBuildPipelineKnownUnavailable(id, scope?)`, `watchBuildPipelineTranscript(id, key, scope?)`, `buildPipelineChangeReadOptions(id, scope?)`, `resetBuildPipelineUnavailableMarkersForTests(scope?)`, `migrateLegacyBuildPipelines(storage?, importLegacy?, load?, scope?)`. Each read holds the scope's store and slot before its awaits.
  - `lib/feature-build-activation.ts`: pending activations and the pipeline-store subscription in `defineScopedSlot("feature-build-activation")`, cleared by `scope.onDispose`; environments from `scope.store(environmentStore)` and `getEnvironment` through `backendApiForScope`. `scheduleBuildPipelineTabActivation(projectId, pipelineId, environmentId?, scope?)`, `activateFeatureBuildEnvironment(projectId, result, scope?)`.
  - `lib/build-pipeline-completion-notes.ts`: `startBuildPipelineCompletionNotes(scope?)` watches `scope.store(buildPipelineStore)`; the service passes its scope.
  - `lib/coordinator-work-navigation.ts`: its 4 singletons (pending workers and reviews and their layout subscriptions) in `defineScopedSlot("coordinator-work-navigation")`; `openCoordinatorWorkTarget(target, navigation?, scope?)`; `CoordinatorWorkNavigation.openBuild(projectId, pipelineId, environmentId, scope)`.
  - `lib/feature-plan-build-compat.ts`: `LegacyFeaturePlanBuildDeps.scope` (required).
  - `lib/workflow-resource-handlers.ts` (new): `workflowResourceHandlers` (build pipelines and Multi Review), `kanbanResourceHandlers`, `featurePlanResourceHandlers`, all `every-scope`, replacing the three `command-scope` registrations in `store-resource-sync.ts` (which re-exports `MAX_DEFERRED_WORKFLOW_READS` and `DEFERRED_WORKFLOW_RETRY_MS` from it). As 3003's note asked, both halves of the shared `workflows` registration moved together and pass `context.scope` to `hydrateBuildPipeline(s…)` and `hydrateMultiReviewWorkflow(s…)`; each scope has its own deferred ids, overflow flag and retry timer.
  - Test support: `build-chat-tab-test-support.tsx` exports `buildChatScope()`, `pipelineStore()`, `renderInBuildChat(ui, options?)`, `cleanupBuildChatScope()`; its `FakeNodeClient` answers `get_build_pipeline` through the suites' `getBuildPipelineControlMock`/`getBuildPipelineConditionalMock` (a read with `knownSessions` is the conditional one).
- **Decision: slots, not services, for the persistence and activation modules (2026-11-07).** Options: (a) a `defineScopedService` per module; (b) a `defineScopedSlot` holding the module's maps, with an optional trailing `scope` on every export (3003's companion-module convention). Neither module runs anything on its own: persistence answers calls and activation subscribes only while an activation is pending. (a) would start a service per scope that does nothing until called. Chosen (b); the activation slot stops its subscription with `scope.onDispose`. Completion notes were already a scoped service (3014) and now watch their own scope's pipelines.
- **Decision: where the moved handlers live (2026-11-07).** As 3004: a dedicated module importing the framework's types only, exporting frozen `{ name, runsOn, register }` objects, so neither the store modules nor `store-resource-sync.ts` gain a cycle. `docs/development/node-scopes.md` names it beside 3004's module.
- **Decision: imperative sites (2026-11-07).** Components and hooks whose suites still render without a provider use `useScopedStoreApi(def)` / `useShimNodeScope(def.name)` (3004's choice); components that already had a scope (`FeaturesView`'s `useScopesWithCommandFallback`, `App`'s `commandScope`, `useEnvironments`' scope) use it; `GraphRunTab`, `GraphDesignerTab` and `useGraphDesignerEditing` read the action through the hook instead of the statics. `CreateEnvironmentFlowDialog` keeps the default (command) scope for `activateFeatureBuildEnvironment`, because the build it activates was created by the command-bound `createFeatureBuild`.
- **Shim counts (`scoped-store-shim`, 2026-11-07).** Before (production imperative sites, by grep): `build-pipeline` 27, `kanban` 8, `feature-plan` 7, `coordinator-pane-layout` 5, `graph-designer` 4, `graph-run` 2, the other three 0. **Now, and the target for Done when: `build-pipeline` 2 in 1 file, every other store of this item 0.** The two are `lib/pane-layout-authoritative.ts` (`hydratePaneLayoutDependencies` and the authoritative reconcile's `hasBuildPipeline`), plain code reached from the pane-layout persistence with no scope; they move with `paneLayoutStore` (3013), as 3003's two `multi-review` sites in the same functions do. The test support's 19 static calls are gone (the suites read `pipelineStore()` and `buildChatScope().store(def)`).
- **`lib-backend-command-default`.** The converted stores and the three slot modules enter the guard with no command-bound use (every call is a factory through `backendApiForScope`, whose command-scope fallback is the named exports). No entries for this item's modules.
- **Behaviour changes (2026-11-07).** (1) A leaf scope's store bindings now refresh that leaf's pipelines, Multi Reviews, board and plans from the leaf (they were `command-scope`). (2) A pipeline change whose read resolves after the sync stopped no longer removes the pipeline (`context.disposed()` is checked after the await). (3) `resetWindowScopeForTests()` now also resets these nine stores and the three slots (they live on the command scope). (4) A leaf's coordinator layouts read and write the legacy browser copy under that leaf's key (`nodeStorageKey`), never the command node's.
- **Where Effect is used, and where not.** Not used. The stores are synchronous zustand creators read during render; the per-scope maps are slots on 2001's Effect-backed scope lifetime, so their `onDispose` cleanup and the stores' timer stops run through that `Scope`'s finalizers. The coordinator coalescing timers and the deferred workflow retry keep their existing `setTimeout` logic; no `Schedule` was needed.
- **Outside the file set (minimal).** `App.tsx` (one call passes `commandScope`), `components/terminal/TerminalContainer.view.tsx`, `hooks/useEnvironments.ts`, `components/linear/LinearTicketsView.tsx`, `components/kanban/KanbanTaskDialog.tsx`, `components/graph-designer/{GraphDesignerTab.tsx,useGraphDesignerEditing.ts}`, `lib/scope-services.test.ts` (the leftover tracker counts the command scope's pipeline instance), `docs/development/node-scopes.md` (two paragraphs). Shared files were committed from a temporary index built on the current HEAD with only this item's hunks.
- **For the orchestrator.** 3013: when `paneLayoutStore` is scoped, pass the scope to `hydrateBuildPipeline`/`isBuildPipelineKnownUnavailable` and read `scope.store(buildPipelineStore)` in `pane-layout-authoritative.ts` (the last 2 `build-pipeline` sites), drop the command-only check in `buildPipelineCompletionNotesService` (then add it to `WARM_SCOPE_SERVICES`), and give `coordinator-work-navigation`'s slot the scope's layout instead of the command singleton.
- **Aggregate suite** left to review preparation (`mise run test` not run).

## Work log

- 2026-11-07 (claude-worker): converted the nine stores to scoped defs with the shim hook (barrel, `SHIMMED_STORES`); their reads go through `backendApiForScope`, their module state into each instance, and the coordinator projections stop on scope dispose. Per-scope slots for `build-pipeline-persistence`, `feature-build-activation` and `coordinator-work-navigation`; completion notes watch their scope's pipelines. Moved the workflows (pipelines plus Multi Review), kanban and feature-plan registrations into `lib/workflow-resource-handlers.ts` as `every-scope`. Converted every imperative site with a scope; moved `build-chat-tab-test-support.tsx` and its eight suites to `renderInNodeScope` (`renderInBuildChat`, `pipelineStore()`). Shim baseline: `build-pipeline` 2, the other eight 0 (`update-baseline.ts --guard scoped-store-shim --guard lib-backend-command-default`). Tests: new `stores/workflow-scoped-stores.test.tsx` (26: per store two scopes and the hook under `renderInNodeScope`, barrel, reads to their own node for all nine, a pipeline launched on the command scope observed from a second scope, pending activation per scope, the moved handlers on a leaf, coordinator timers and listeners stopped on dispose); updated `store-resource-sync.test.ts`, `coordinator-work-navigation.test.ts` (+1, scope passed to `openBuild`), `kanbanStore.test.ts`, `scope-services.test.ts`. Focused runs pass: `src/components/build-pipeline` (687), graph designer, graph run, graph launch, kanban, projects and linear suites plus the graph and coordinator store tests, `src/stores`, and the persistence, activation, completion-notes, navigation, resource-sync and scope-services suites. Whole web suite earlier in the item: failures only in suites other agents were editing (uiStore split, federation sidebar). `tests/unit/source-guards.test.ts`: only the pre-existing test-guard findings fail. Web typecheck: no errors in this item's files. fmt and oxlint clean on touched files. Commits 4ea7ebf13 (stores, slots, handlers, sites, tests) and 49b4b6c1f (build tab suites in a node scope, barrel defs, docs, notes).
- 2026-11-07 (claude-worker, plan item 3013): the open box. `buildPipelineCompletionNotesService` no longer refuses a non-command scope: `startBuildPipelineCompletionNotes(scope)` watches `scope.store(buildPipelineStore)` and opens the notes in `scope.store(paneLayoutStore)` (`openKeyInformationTab` takes the scope), and the service is in `WARM_SCOPE_SERVICES` (so also in `COMMAND_SCOPE_SERVICES`). `coordinator-work-navigation`'s slot holds the scope's own pane layout and focuses through `openConversationTab(…, scope)`/`requestPaneTabActivation(…, scope)`; the last 2 `build-pipeline` shim uses in `pane-layout-authoritative.ts` are gone. Test: `stores/paneLayoutStore.scopes.test.tsx` "a leaf's completion notes open in the leaf's own layout"; `scope-services.test.ts` runs the service on the leaf. Every box is ticked, so the item is done.
