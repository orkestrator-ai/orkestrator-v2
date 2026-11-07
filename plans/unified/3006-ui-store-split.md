---
id: 3006
title: "Split uiStore: node-qualified selection in the window, per-node UI state in the scope"
phase: 3
plan: "§7.1 class (d) and §12 Phase 3.3"
status: done
depends_on: [3004, 3017]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3006 · Split uiStore: node-qualified selection in the window, per-node UI state in the scope

- **Report:** [§7.1](../../docs/reports/unified-federation.md#71-inventory), [§12 Phase 3](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [3004](3004-project-and-environment-stores.md), [3017](3017-window-stores-node-qualified.md)
- **Blocks:** [3013](3013-pane-layout-store.md), [4005](4005-direct-navigation.md)
- **Size:** M–L
- **Track:** S (scopes)

## Goal

One window-level selection, `{ nodeId, projectId, environmentId }`, plus per-node collapse and recents state.

## Current state (verified 2026-11-07)

- `uiStore`: 344 LOC, 54/27 imperative sites, 38 direct importers, 55 references, 59 test files. It uses `persist`.
  - It imports `portal/portal-transport` (`workspaceTarget`) and `portal/portal-store` (:49, the leaf-mode check), plus `desktop-storage-key` and `ui-state-storage`.
- `remoteWorkspaceStore` (289 LOC) reads and subscribes to `uiStore` and `machineViewStore` (:221-260). About 90 lines of it survive as the node-qualified selection and recents (Appendix D).
- `lib/pane-selection-storage.ts` (495 LOC) keys `WINDOW_*` with `desktopConnectionStorageKey`.

## Work

- [x] Move the window part (selection, recents across nodes) into a window store: `windowSelectionStore`, the node-qualified selection, taking over `remoteWorkspaceStore`'s `realms`/`active` semantics as "shown node".
- [x] Move the per-node part (collapse state, per-project UI) into a scoped `uiStore` with node-namespaced persistence ([3015](3015-persistence-keys-per-node.md)).
- [x] Remove the dependency on `portal-transport` and `portal-store`: leaf mode comes from the scope's role.
- [x] Keep `remoteWorkspaceStore` working for realms by deriving it from the window selection until [6002](6002-delete-web-realm-code.md).

## Tests

- [x] Selecting on node B does not change node A's per-node state; the selection survives reload; existing `uiStore.persistence.test.ts` behaviour is kept for the command node.

## Done when

- [x] `uiStore`'s shim count is at the recorded target, and the selection is node-qualified everywhere it is read.

## Notes

- **API (2026-11-07).**
  - `lib/node-scope/window-scope.ts` (additive): `NodeSelection.projectHome?` (a realm reports it), `sameNodeSelection(a, b)`, `windowScopeOf(scope): WindowScope | null` (a registry filled by `open`), and `select()` now ignores a value equal to the current one.
  - `stores/windowSelectionStore.ts` (new): the window selection is `WindowScope.selection` itself, so each window scope (and each test's) has its own and 2011's `adoptCommandNodeId` carries it to the proven id. Helpers: `windowSelection(windowScope?)`, `selectionScope(windowScope, selection?)`, `selectionOnScope(scope, selection?)` (through the window's registry, so a provisional-id selection still matches), `isCommandNodeSelection(windowScope, selection)` (`null` counts as the command node's), `useWindowSelection()`, `noteNodeSelectionRecents(selection)` (the recents/highlight bookkeeping that was `remoteWorkspaceStore`'s), `readStoredWindowSelection(storage?)`, `bindWindowSelectionPersistence(windowScope, { restore, storage? })` and `windowSelectionPersistenceService` (command scope only; in `COMMAND_SCOPE_SERVICES`).
  - `stores/uiStore.ts`: `uiStore = defineScopedStore<UIState>("ui", …)`, `useUIStore = scopedStoreHook(uiStore)`, `UIState` and `mergePersistedUIState` exported, `createUIStore` gone. Per node: the selection's projection (`selectedProjectId`, `selectedEnvironmentId`), `projectSelectionRevision`, `projectBoardTab`, recents, collapsed projects and folders, collapse choices, multi-selection, expanded sessions, opened leaf coordinators. Persisted under `nodeStorageKey("ui-project-storage", scope)` (`createUIStateStorage(scope)`), with the same adoption of older records as before.
  - `stores/uiChromeStore.ts` (new): `useUIChromeStore`, `createUIChromeStore`, `mergePersistedUIChrome`, `UIChromeState`; the window's sidebar open/width, zoom, sort mode and order, graph heights, data saving and the coordinator intro, persisted under `windowStorageKey("ui-storage")` (`createUIWindowStateStorage()`), plus a new `setSidebarOpen`. `EnvironmentSortMode`/`ActivitySortOrder` live here (re-exported from `uiStore`).
  - `lib/federation/leaf-node.ts` (new): `scopeNodeIsLeaf(scope)`, the board tab a project lands on.
  - `stores/remoteWorkspaceStore.ts`: `active` is derived (`activeFor`: the selection while it is on an open realm's node); `open`, `noteRealmSelection`, `closeRealm` and `showLocal` move the window selection; `startRemoteWorkspaceSelectionSync()` now watches the window selection. `clearLocalSelection` and its flag are gone: the command node's `uiStore` projects nothing while the selection is elsewhere.
- **Decision: where the selection lives (2026-11-07).** Options: (a) a module zustand store `windowSelectionStore`; (b) 2001's `WindowScope.selection` signal, with the module as its API. (a) is one per renderer, so test window scopes would share it, and it would need its own handling of 2011's proven-id move. Chosen (b): the module keeps the item's name; nothing holds a second copy.
- **Decision: how `uiStore` carries the selection (2026-11-07).** Options: (a) drop `selectedProjectId`/`selectedEnvironmentId` from `uiStore` and change every reader (some 150 hook reads and the tests that seed them) to the window selection; (b) keep them as the node's projection of the window selection: a subscription sets them from the selection (null while another node is shown), and the store's own subscription moves the selection to this node on explicit navigation (a new revision, or an environment chosen) or while this node is shown, which is exactly the rule `startRemoteWorkspaceSelectionSync` applied to the command node before. Chosen (b): hook readers stay node-qualified by their scope; the window selection is the one source (a projection write never publishes back, guarded by a flag). When the selection leaves a node, its store gets what `selectProject(null)` gave it before (ids and multi-selection cleared, revision bumped, board tab reset), so the behaviour behind a realm is unchanged. A selection set on the window directly (a restore, or 4005's direct navigation) is projected without a revision bump; 4005 should call the target scope's `uiStore` actions for user navigation.
- **Decision: the chrome is a window store (2026-11-07).** The item names only selection and recents as the window part, but §5.1 puts sidebar and zoom in the `WindowScope`, and a per-node instance of them would let a leaf's workspace toolbar read its own sidebar state. Options: (a) keep them in the scoped store, mirrored from a window store; (b) a plain window store, as 3007's `filesPanelChromeStore`. Chosen (b), no mirror: 12 production readers and about 20 test files moved to `useUIChromeStore`. The window record keeps an earlier release's project fields until the command node's store moves them (tested), so a chrome write that happens first loses nothing.
- **Decision: the selection survives a reload in session storage, the command node's only (2026-11-07).** Before, a reload lost it (realm documents kept theirs in their URL). Session storage keeps it across a reload but not into a new window or an app restart, so a cold start is unchanged; the key is the command node's (`desktopConnectionStorageKey`), so a browser realm document keeps its own. Another node's selection is not stored: its realm reopens itself, and in-tree leaves (Phase 4) do not exist yet. Restored once per document, only while nothing is selected (a `?resource=` link wins). Visible behaviour change: after a renderer reload the last environment is shown again.
- **Deviation: leaf mode for the app's command scope (2026-11-07).** `uiStore` no longer imports `portal-transport` or `portal-store`, and a leaf scope lands on its home by its role. The app window's command scope still learns that its own node is a leaf from the page: a workspace realm document (`workspaceTarget()`, until 6002 deletes realms) or the command node's federation status (`portalStore`, mode `leaf`, a property of that node). Both reads are in `lib/federation/leaf-node.ts` and apply only to the app's command scope (`isAppCommandScope`), never to a test's window scope or a leaf scope. When 6002 removes realm documents, the `workspaceTarget()` branch goes; the status read could move to the scope once the hello's `nodeMode` is on `NodeClient`.
- **3008's request done.** `useLiveHostScopeGuard` reads the owner node's multi-selection from `owner.store(uiStore)` and the window selection (subscribed). An environment selected on another node is compared by its node-qualified key, so moving to another node's environment now ends a live view (before, opening a realm cleared the local selection to null, which never counted as a switch); selecting only another node's project still does not.
- **Window-level readers now read the window selection:** `sidebar-selection.ts` (the shown row), `MachineAgentAccountsSection.environmentOnScreen`, `useNotificationSoundService.coordinatorOnScreen` (the node and project, then that node's board tab), `bug-report/client-context.ts` (what the command node shows, and its environment from the command scope's store: 3004's `[environment]` site there is gone too), `pull-request-opener.currentFilesPanelTargetId(scope = command)` (and 3004's `[project]` site), `ArtifactLiveHost`. Plain code that acts for the window's own node names it: `appCommandScope().store(uiStore)` (`sidebar-selection`, `question-desktop-notification`, `MachineAgentAccountsSection`) or `getWindowScope().commandScope()` (`open-workspace`); `coordinator-work-navigation`'s `selectEnvironment` and `feature-build-activation`'s `activate` use the scope they already take.
- **Shim count (`scoped-store-shim`, 2026-11-07).** The item's count was 54 imperative sites (27 in plain `.ts`). Now, and the target for Done when: **`ui`: 2 in 1 file**, `components/federation/WorkspaceRealmHost.tsx`: a realm document's report of its own selection and its handling of the window's request. That is realm-only code that 6002 deletes, its command scope is the realm's node (the node those calls mean), and another agent has uncommitted work on the same lines. Baseline regenerated with `update-baseline.ts --guard scoped-store-shim --guard lib-backend-command-default`; it includes other agents' uncommitted state, which the orchestrator regenerates.
- **Effect.** Not used. The selection is 2001's synchronous signal on the Effect-backed `WindowScope`; the `uiStore` subscriptions are released through `scope.onDispose` (the scope's Effect `Scope` finalizers), and the persistence is a scoped service whose lifetime is a child `Scope`. Session storage, projections and stores are plain synchronous code that zustand and React read.
- **Outside the file set (minimal).** `lib/scope-services.ts` (one service in `COMMAND_SCOPE_SERVICES`), `lib/scope-services.test.ts` (the data-saving service now subscribes to `uiChromeStore`), `components/layout/ActionBar.test.tsx` (mocks `@/stores/uiChromeStore` like `filesPanelChromeStore`, restored in `afterAll`), `hooks/useEnvironments.ts` (3 sites), `lib/coordinator-work-navigation.ts` and `lib/feature-build-activation.ts` (one site each), the chrome readers listed above, `docs/architecture/federation.md` ("Which realms are open", sidebar width, recents) and `docs/development/node-scopes.md` (one bullet).
- **For the orchestrator/report.** §7.1 class (d) could say the `uiStore` split is three parts: the window selection (on `WindowScope`), the window chrome store and the scoped store. 4005 builds direct navigation on `windowScope.select` plus the target scope's `uiStore` actions; `remoteWorkspaceStore.active` keeps requiring an open realm, so an in-tree leaf's selection does not open a realm.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): node-qualified window selection on `WindowScope` (`windowSelectionStore`: helpers, reload persistence service), scoped `uiStore` projecting it with node-keyed persistence, `uiChromeStore` for the window chrome, `remoteWorkspaceStore.active` derived from the selection, leaf landing by scope role (`leaf-node.ts`), 3008's live-host guard on the node-qualified selection; imperative sites converted (54 → 2, both in realm-only `WorkspaceRealmHost`), chrome readers and tests moved, guard entry and baseline. Tests: new `stores/uiStore.test.ts` (8: node B leaves node A's state alone, one selection projected per node, deselection on a hidden node, a window-set selection, dispose, proven-id move, realm open/report/local return, close and show-local) and `stores/windowSelectionStore.test.ts` (6: survives a reload, command node only, restore never replaces, corrupt records, the service, registry reads); `uiStore.persistence.test.ts` kept for the command node on scopes, plus a leaf-scope landing case and a legacy-record move. Whole web suite (`bun test src --parallel=4`): 14,008 pass, 0 fail. Web typecheck: no errors in touched files (other agents' in-progress errors elsewhere). fmt and oxlint clean on the touched files; no `import/no-cycle` finding. `tests/unit/source-guards.test.ts`: the two failures are other items' (`coordinator-activity` barrel, test-file findings).

