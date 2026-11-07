---
id: 3007
title: "Split filesPanelStore and convert projectPullRequestsStore"
phase: 3
plan: "§7.1 class (d) and §12 Phase 3.3"
status: done
depends_on: [3001, 3002, 3015]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3007 · Split filesPanelStore and convert projectPullRequestsStore

- **Report:** [§7.1](../../docs/reports/unified-federation.md#71-inventory)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md), [3002](3002-lib-backend-client-parameter.md), [3015](3015-persistence-keys-per-node.md)
- **Blocks:** [3013](3013-pane-layout-store.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

The files panel's open state and width are per window. Its folders, PR tabs and selection are per node.

## Current state (verified 2026-11-07)

- `filesPanelStore`: 445 LOC, 20/11 imperative sites, 15 direct importers, 26 test files. It uses `persist` keyed by `desktopConnectionStorageKey`.
- `projectPullRequestsStore` (173 LOC, 0 sites) imports a type from it, persists, and is keyed the same way.
- `hooks/useFilesPanel.ts` has 16 sites and per-project maps (Appendix B).

## Work

- [x] Window store `filesPanelChromeStore` (open, width), shared by all nodes as today.
- [x] Scoped `filesPanelStore` for folders, PR tabs and selection. Scoped `projectPullRequestsStore`.
- [x] `useFilesPanel` maps per scope.

## Tests

- [x] Opening the panel on one node opens it for all; folder expansion stays per node; persistence keys are per node.

## Done when

- [x] Both stores are converted, and the files panel works for the command scope.

## Notes

- **API (2026-11-07).**
  - `stores/filesPanelChromeStore.ts`: `useFilesPanelChromeStore` (plain window store: `isOpen`, `panelWidth`, `togglePanel`, `openPanel`, `closePanel`, `setPanelWidth`), `FILES_PANEL_DEFAULT_WIDTH_PX`, `legacyFilesPanelWidth()`. Persists only `panelWidth`, under `windowStorageKey("files-panel-chrome")`; `isOpen` stays session-only as before.
  - `stores/filesPanelStore.ts`: `filesPanelStore` (def `"files-panel"`), `useFilesPanelStore = scopedStoreHook(filesPanelStore)`, exported `FilesPanelState`, `PersistedFilesPanelState`, `mergePersistedFilesPanelState(persisted, current)`, `sanitizePersistedPullRequestTabs`. Persists `expandedFolders` and `pullRequestTabs` under `nodeStorageKey("files-panel-storage", scope)`. `openPullRequest` and `openPanelOnAllFiles` set this node's tab and open the window's panel.
  - `stores/projectPullRequestsStore.ts`: `projectPullRequestsStore` (def `"project-pull-requests"`), `useProjectPullRequestsStore` (shim hook), exported `ProjectPullRequestsState`, `mergePersistedProjectPullRequests`. Key `nodeStorageKey("project-pull-requests", scope)`. Both defs are in the `@/stores` barrel (the barrel test requires every registered hook there).
  - `lib/node-scope/scoped-store-shim.ts`: `useShimNodeScope(storeName): NodeScope` and `useScopedStoreApi(def): StoreApi<S>`, the nearest node scope (or the def's instance in it) for imperative code in a component or hook; outside a provider they fall back to the command scope and call `noteShimUse(name, "hook-without-provider")`, exactly as the shim hook does. Documented in `docs/development/node-scopes.md` (pieces table, imperative-sites table, and persisted/split stores in step 1).
  - `lib/file-subtree-loads.ts`: `loadFileSubtree(scope, key, directory, reload, read)`; the in-flight map and the four-read limit are a scoped slot (`"file-subtree-loads"`), so each node has its own limit.
  - `lib/project-home-ensures.ts` (new): `ensureProjectHomeInStore(projectId, scope = appCommandScope())`, `drainProjectHomeEnsures(projectId, scope = appCommandScope())`, `isProjectHomeDeletionInProgress(projectId)`. The in-flight ensures are a scoped slot (`"project-home-ensures"`); the backend call goes through `backendApiForScope(scope, createProjectsEnvironmentsApi, …)`. `hooks/useFilesPanel.ts` re-exports all three, so importers are unchanged.
  - `lib/pull-request-opener.tsx`: `openPullRequestInApp(ref, view?, scope?)`; `usePullRequestOpener()` binds the nearest scope.
  - `apps/web/src/test/files-panel-state.ts` (test-only): `setFilesPanelTestState(partial, store?)` and `filesPanelTestState(store?)`, which split/merge the window and node fields, so the many suites that set `isOpen` with the panel state keep one call.
- **Decision: where the open state and width live.** Options: (a) a window store next to the scoped store; (b) keep them in the scoped store and mirror between scopes; (c) put them in `uiStore`'s window part (3006). (b) needs a sync and can disagree; (c) couples to 3006, which was being converted at the same time. Chosen: (a), a plain zustand singleton like the other class (b) window stores (report §7.1).
- **Decision: the width's key and migration.** The width was part of the command node's `files-panel-storage` value. The chrome store keys it by window (`windowStorageKey`, like `ui-storage`) and, while the window has none of its own, starts from the old value (`legacyFilesPanelWidth`, bounded 120–4096 px). The node store's `merge` reads only `expandedFolders` and `pullRequestTabs`, so the old `panelWidth` field is ignored and dropped on the next write. No `PERSISTENCE_KEY_MIGRATIONS` entry: the node keys themselves did not change (3015 already gave them the node), only one field moved. Note: nothing calls `setPanelWidth` today (the resizable panel keeps its own layout), so the width is effectively the default.
- **Decision: "selection" per node** is the active tab (`changes`/`all-files`/a pull request tab), which names node-local pull request tabs, plus the pending file opens (environment ids). Both are in the scoped store.
- **Decision: imperative sites in components whose tests render without a provider.** `useNodeScope()` throws outside a provider in tests, and about 30 suites render these components bare. Options: move every suite to `renderInNodeScope` now (large, overlapping other items' suites), or name the nearest scope with a fallback that is noted as a shim use (`useShimNodeScope`/`useScopedStoreApi`). Chosen: the fallback; under `App` every site now names its scope, and 4004's runtime guard sees the fallback. Switch to `useNodeScope()` when those suites move.
- **Shim uses (2026-11-07):** `files-panel`: 1 shim use in 1 file (`lib/pull-request-opener.tsx`, the `openPullRequestInApp` path for callers with no scope: `AgentMailPanel`, `KanbanTaskDialog`, `terminal-links`, `openPullRequestUrl`); `project-pull-requests`: 0. Converted: `PullRequestPaneTab`, `FilesPanel`, `TerminalContainer.view` (pending file open), `RequestCard`, `useProjectHomeActivation`, `useFilesPanel` (all 8), `file-subtree-loads` (3), `ProjectPullRequestsView`. `RemoteWorkspaceRegion` and `WorkspaceRealmHost` now read and write the window store (the realm `filesPanel` message is window state, report Appendix C).
- **Moved shim uses of other stores:** the project home ensures moved from `hooks/useFilesPanel.ts` to `lib/project-home-ensures.ts` with their `useProjectStore`/`useEnvironmentStore` statics (`[project]` 4, `[environment]` 2 there). They read the command scope's project and environment stores until plan item 3004 lands its defs; then they should read `scope.store(projectStore)`/`scope.store(environmentStore)`.
- **Effect.** Not used: synchronous zustand stores, `persist` and a `localStorage` field read. The per-node lifetimes come from the scope (stores and slots are dropped with it), which is already an Effect Scope underneath.
- **Persisted scoped stores.** `persist` inside the def's creator works unchanged: hydration from `localStorage` is synchronous when `scope.store(def)` first creates the instance. The def's `StateCreator<S>` type does not carry `persist`'s mutator, so the merge functions are exported for tests instead of `store.persist.getOptions()`.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): split the files panel into `filesPanelChromeStore` (window) and scoped `filesPanelStore`; converted `projectPullRequestsStore`; per-scope directory reads and project home ensures; `useShimNodeScope`/`useScopedStoreApi`; converted the imperative sites listed in Notes; `SHIMMED_STORES` entries; test helper and suite updates (about 30 suites set `isOpen` with the panel state). Tests: `filesPanelStore.test.ts` (3 new: open-for-all/per-node folders and tabs, per-node keys and reload, pre-split value), `filesPanelChromeStore.test.ts` (3 new), `projectPullRequestsStore.test.ts` (1 new), `file-subtree-loads.test.ts` (1 new: per-node limit). Web: 997 tests across 31 files, 993 pass; the 4 failures are `ActionBar` Multi Review launch tests, from another item's uncommitted `multi-review-launch-compat` change, not this one. `tests/unit` files-panel suites: 194 pass across 6 files. `tests/unit/source-guards.test.ts`: 48 pass; the repository ratchet fails on other guards' findings, and the barrel test on `tab-launch` (3003's, uncommitted). Web typecheck clean in this item's files (other items' in-flight errors remain); oxlint and fmt clean on the touched files.
