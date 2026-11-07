---
id: 3004
title: "Convert projectStore and environmentStore"
phase: 3
plan: "§12 Phase 3.2"
status: done
depends_on: [3001, 3002, 3016]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3004 · Convert projectStore and environmentStore

- **Report:** [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md), [3002](3002-lib-backend-client-parameter.md), [3016](3016-rich-content-and-caches.md) (`environmentStore` imports `rich-content-reset`)
- **Blocks:** [3006](3006-ui-store-split.md), [3009](3009-agent-and-transcript-stores.md), [3011](3011-workflow-stores-a.md), [3012](3012-workflow-stores-b.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

The core lists every node workspace needs are per node.

## Current state (verified 2026-11-07)

- `environmentStore`: 248 LOC, 57 imperative sites (46 in `.ts`), 45 direct importers, about 72 references, 96 test files.
  - Its only non-store dependency is `lib/chat/rich-content-reset` (identity clear), which [3016](3016-rich-content-and-caches.md) makes per node.
- `projectStore`: 149 LOC, 16/12, 13 direct importers, about 31 references, 38 test files. It has no store or service dependencies.
- Heaviest modules:
  - `hooks/useEnvironments.ts` has 21 sites;
  - `hooks/useProjects.ts` holds per-project maps and write tails (Appendix B);
  - `lib/store-resource-sync.ts` has 35 sites across stores; move the ones for these two stores here.

## Work

- [x] Convert both stores and `useEnvironments`/`useProjects` (whose module maps become per scope).
- [x] Move the `store-resource-sync.ts` handlers for projects and environments to a per-scope service ([3014](3014-scoped-services-and-startup.md) provides the framework; if it has not landed, register the handlers through the command scope and leave a box there).
- [x] Convert imperative sites with a known scope. List the remaining shim sites per file in Notes.

## Tests

- [x] Two scopes with the same environment id (allowed: ids are node-local) do not collide.
- [x] The parity tests (`sidebar-parity.test.tsx`, `remote-row-parity.test.tsx`, `environment-row-model.parity.test.ts`) still pass.

## Done when

- [x] Both stores are converted, and the shim count for each is at or below the target recorded in Notes.

## Notes

- **API (2026-11-07).**
  - `stores/environmentStore.ts`: `environmentStore = defineScopedStore<EnvironmentState>("environment", …)`, `useEnvironmentStore = scopedStoreHook(environmentStore)`, `EnvironmentState` exported. Actions unchanged.
  - `stores/projectStore.ts`: `projectStore = defineScopedStore<ProjectState>("project", …)`, `useProjectStore = scopedStoreHook(projectStore)`, `ProjectState` exported. The module-level `projectMutationVersion` and the free functions `getProjectMutationVersion`, `invalidateProjectSnapshots` and `applyProjectSnapshot` are gone: the version is a closure variable of each scope's instance (not state, so no selector re-renders for it), read through the new `@internal` actions `getMutationVersion()`, `invalidateSnapshots()` and `applySnapshot(projects, expectedVersion) → boolean`. A mutation on one node never stales another node's read.
  - Both defs are exported from the `@/stores` barrel next to their hooks.
  - `hooks/useEnvironments.ts`: one `environment-lifecycle` slot per scope (`defineScopedSlot`) holding what were five module singletons (creations per project, start attempts, reported lifecycle failures, the setup reconciliation promise and its re-request flag) plus the scope's two store instances. Exported functions take a required trailing `scope: NodeScope`: `cleanupSubscriptionsRemovedByProjectSnapshot(projectId, envs, scope)`, `refreshEnvironmentSnapshot(projectId, environmentId, scope)`, `reconcileEnvironmentLifecycleErrors(scope)`, `reconcileEnvironmentSetupSnapshots(scope)`, `applyEnvironmentSetupComplete(payload, scope)`. `useEnvironments` returns `refreshEnvironmentSnapshot(projectId, environmentId)` bound to its scope (same shape for `useEnvironmentListSync` callers). Every command goes through `backendApiForScope(scope, createProjectsEnvironmentsApi, backend)` (and `createFilesSessionsApi` for `updatePortMappings`); every event (`environment-renamed`, `environment-setup-started`/`-complete`, `native-agent-async-question`, the stream-connected event) through `listenInScope(scope, …)`. `useEnvironmentLifecycleService` reads its scope from the nearest provider (the command scope where `App` mounts it).
  - `hooks/useProjects.ts`: one `project-loads` slot per scope (the shared in-flight read, was module `latestProjectLoad`). `loadProjectsFromBackend(scope)`; the hook's `loadProjects()` is bound to its scope; its change and resync subscriptions name the scope (`onResourceChanged(…, scope)`, `onResourceResync(…, scope)`).
  - `lib/project-environment-resource-handlers.ts` (new): `projectResourceHandlers` and `environmentResourceHandlers`, both `every-scope`, listed first in `STORE_RESOURCE_HANDLERS`. Each reads its own scope's node (`backendApiForScope`, a test's `context.options.getProjects`/`getEnvironmentSnapshots` still wins) and writes that scope's stores, with the same staleness guards as before (array identity plus the per-scope mutation version, `pass.requeue`).
  - Signatures that gained a scope (callers updated): `environment-cleanup-selection.ts` (`activateProjectForEnvironmentCleanup(id, scope, previous?)`, `reconcileSelectedEnvironmentCleanupSelection(scope)`, `startEnvironmentCleanupSelectionSync(scope)`), `setup-commands.ts` (`forceResolveSetupRuntime(id, scope)`, `retrySetupRuntime(id, scope)`, `approveSetupRuntime(id, hash, remember, scope)`, through `backendApiForScope(scope, createConfigIntegrationsApi, backend)`), `DiffBaseDialog.saveDiffBase(id, base, scope)` (its in-flight queue is keyed by node and environment), `HierarchicalSidebar.deleteProjectAndEnvironments(…, scope)`, `project-home-ensures.isProjectHomeDeletionInProgress(projectId, scope?)` (3007's optional-scope pattern kept; every caller now passes one).
- **Decision: where the per-scope module state lives (2026-11-07).** Options: (a) inside the store state (non-rendered fields); (b) a scoped slot in the hook module; (c) a module `WeakMap<NodeScope, …>`. Chosen (b) for `useEnvironments`/`useProjects`: it is 3016's sanctioned per-scope mutable state, dies with the scope, and keeps bookkeeping that no component renders out of store state. The project mutation version is the exception: the store's own actions advance it, so it is a closure variable of the store's creator (per instance, no slot needed).
- **Decision: the scope imperative call sites use (2026-11-07).** Options: (a) `useNodeScope()` as the recipe's first row says; (b) `useScopesWithCommandFallback().scope`; (c) 3007's `useShimNodeScope(name)` / `useScopedStoreApi(def)`. (a) throws outside a provider in tests, and about 96 suites render readers of these stores with plain `render`. Chosen (c): it is the same scope the shim hook reads, and the fallback is noted as a shim use, so 4004's runtime guard sees it. `AppDialogHost`'s delete-project host, which always renders under a `NodeScopeProvider`, uses `useNodeScope()`.
- **Decision: where the moved handlers live (2026-11-07).** Options: (a) the store modules (the recipe); (b) the hook modules; (c) a dedicated module. (a) makes the stores import `@/lib/backend` (suites replace that barrel with partial mocks, and the store modules are imported almost everywhere) and, calling `defineStoreResourceHandlers`, an import cycle with `store-resource-sync.ts`; (b) is a cycle risk through `useFilesPanel`/`pane-layout-authoritative`. Chosen (c), importing the framework's types only (type-only imports are not cycles for `import/no-cycle`, checked) and exporting the frozen `{ name, runsOn, register }` shape. Recorded in `docs/development/node-scopes.md` ("Moving a store's change handlers"). **For 3014/the orchestrator:** if more store items hit the same cycle, moving `defineStoreResourceHandlers` and its types into their own module would let them call it.
- **Deviation: `clearRichEnvironmentContent(environmentId)` stays keyed by environment id alone (2026-11-07).** The 3016 caches' `clearEnvironment` hook takes no node, so deleting `env-1` on one node also drops another node's derived rich content for its `env-1`. That is a re-render there, never a leak; making it per node means changing every registered cache's interface (3016's), so it is left as a comment in `removeEnvironment`.
- **Behaviour changes (2026-11-07).** (1) Under a node scope provider for another node (`AppDialogHost` with a request for node B), `useEnvironments`/`useProjects` and every converted call site now read and write that node's lists and send their commands to it; the `AppDialogHost` suite seeds node B's store accordingly. (2) A leaf scope's store bindings now run the project and environment resync for that leaf (they were `command-scope`); `scope-services.test.ts` expects the `every-scope` registrations on a leaf. (3) `ArtifactLiveHost`'s scope guard watches the live target's node's environments (`artifactLiveHostOwner(nodeId)`) and only while a live view is active. (4) `resetWindowScopeForTests()` now also resets both stores and the lifecycle bookkeeping (they live on the command scope).
- **Shim counts (`scoped-store-shim`, 2026-11-07).**
  - At conversion (stores converted, no site changed): `environment` 68 in 28 files, `project` 19 in 10 files (the plan's 57/16 predate 3014's registrations split and 3007's `project-home-ensures.ts`).
  - Now, and the target for Done when: **`environment`: 11 in 6 files; `project`: 2 in 2 files.**
  - Remaining sites, all plain code with no caller that has a scope yet:
    - `lib/pane-layout-authoritative.ts` (environment 4): the authoritative pane-layout reconcile and setup handoffs, reached from `store-resource-sync`'s `command-scope` pane-layout registration and module-level activation maps; they move with `paneLayoutStore` (3006).
    - `lib/feature-build-activation.ts` (environment 2): a module-level build-pipeline subscription with pending activations by pipeline id; moves with `buildPipelineStore` (3011/3012).
    - `lib/question-desktop-notification.ts` (environment 2, project 1): window-level desktop notifications for this window's own (command) node; remote nodes already pass their label.
    - `lib/bug-report/client-context.ts` (environment 1): the window's on-screen identifiers for a bug report (window-level).
    - `lib/preview-link-external.ts` (environment 1): called from `terminal-xterm.ts` link handlers and the preview service store, neither scoped yet.
    - `lib/web-annotations/navigation.ts` (environment 1): opens an agent tab through the pane layout store (3006).
    - `lib/pull-request-opener.tsx` (project 1): `currentFilesPanelTargetId()`, 3007's window-level target; it would keep one fallback branch either way.
- **`lib-backend-command-default`.** The new slot modules (`useEnvironments.ts`, `useProjects.ts`) enter the guard and have no command-bound use (every call is a factory through `backendApiForScope`, whose command-scope fallback is the `@/lib/backend` namespace, so suites that mock it see every call). The `[projects-environments] apps/web/src/lib/scope-services.ts` 3 entries are 3014's manifest reads, not this item's. Not regenerated by this item.
- **Effect.** Not used. The stores are synchronous zustand state read during render; the per-scope bookkeeping is a slot on 2001's Effect-backed scope lifetime, so its cleanup still runs through that `Scope`'s finalizers. The handlers run inside 3014's service, which owns the signal and lifetime.
- **Outside the file set (minimal).** `lib/scope-services.test.ts` (3014: the leaf now runs the `every-scope` registrations), `lib/project-home-ensures.ts`, `hooks/useFilesPanel.ts`, `hooks/useProjectHomeActivation.ts`, `components/kanban/FeaturesView.tsx`, `components/chat/rich/ArtifactLiveHost.tsx`, `components/files-panel/{FilesPanelHeader,DiffBaseNotice}.tsx` (3007/3008/3005 files, each one or two lines, after those items committed), and `docs/development/node-scopes.md` (one paragraph).
- **Aggregate suite** left to review preparation.

## Work log

- 2026-11-07 (claude-worker): converted `environmentStore` and `projectStore` to scoped defs with the shim hook (barrel, `SHIMMED_STORES`); moved `useEnvironments`' five lifecycle singletons and `useProjects`' shared read into per-scope slots, their commands onto `backendApiForScope` factories and their events onto `listenInScope`; replaced the project mutation-version module state with per-instance actions; moved the project and environment resync registrations out of `store-resource-sync.ts` into `lib/project-environment-resource-handlers.ts` as `every-scope`, and pointed the remaining `command-scope` registrations at `context.scope`; converted every imperative site with a scope (components and hooks through `useShimNodeScope`/`useScopedStoreApi`, plain code through a scope parameter). Shim baseline: `environment` 68 → 11, `project` 19 → 2 (`update-baseline.ts --guard scoped-store-shim --guard lib-backend-command-default`). Tests: new `lib/project-environment-resource-handlers.test.ts` (3), `hooks/useEnvironments.scopes.test.tsx` (1, two `renderInNodeScope` scopes with the same ids), per-node cases in `environmentStore.test.ts` (+2) and `projectStore.hydration.test.ts` (+3); suites moved to explicit scopes or `appCommandScope()`. Whole web suite (`src`): 13,846 pass, 2 fail, both `lib/backend/factories.test.ts` on 7004's new `domain-client.ts`. Parity suites pass. `tests/unit/source-guards.test.ts`: only other files' test-guard findings fail. Web typecheck clean; fmt and oxlint clean on touched files.
