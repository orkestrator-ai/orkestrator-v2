---
id: 3006
title: "Split uiStore: node-qualified selection in the window, per-node UI state in the scope"
phase: 3
plan: "§7.1 class (d) and §12 Phase 3.3"
status: not-started
depends_on: [3004, 3017]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Move the window part (selection, recents across nodes) into a window store: `windowSelectionStore`, the node-qualified selection, taking over `remoteWorkspaceStore`'s `realms`/`active` semantics as "shown node".
- [ ] Move the per-node part (collapse state, per-project UI) into a scoped `uiStore` with node-namespaced persistence ([3015](3015-persistence-keys-per-node.md)).
- [ ] Remove the dependency on `portal-transport` and `portal-store`: leaf mode comes from the scope's role.
- [ ] Keep `remoteWorkspaceStore` working for realms by deriving it from the window selection until [6002](6002-delete-web-realm-code.md).

## Tests

- [ ] Selecting on node B does not change node A's per-node state; the selection survives reload; existing `uiStore.persistence.test.ts` behaviour is kept for the command node.

## Done when

- [ ] `uiStore`'s shim count is at the recorded target, and the selection is node-qualified everywhere it is read.
