---
id: 3015
title: "Persistence keys take a nodeId"
phase: 3
plan: "§7.5 and §12 Phase 3.8"
status: not-started
depends_on: [2001]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 3015 · Persistence keys take a nodeId

- **Report:** [§7.5 Persistence keys](../../docs/reports/unified-federation.md#75-persistence-keys)
- **Decision:** 13.7 A (abandon desktop realm partition data)
- **Depends on:** [2001](2001-node-scope-core.md)
- **Blocks:** [3007](3007-files-panel-split.md), and the persistence parts of [3006](3006-ui-store-split.md), [3012](3012-workflow-stores-b.md), [3013](3013-pane-layout-store.md)
- **Size:** S
- **Track:** S (scopes)

## Goal

In one renderer, each node's persisted presentation state lives under its own key, and existing data is read where it already is.

## Current state (verified 2026-11-07)

- `lib/desktop-storage-key.ts` (113 LOC): `desktopConnectionStorageKey` (:59) derives the namespace from the renderer's single identity. `windowStorageKey` (:74) is already right.
- Users:
  - `legacy-local-state.ts`
  - `ui-state-storage.ts`
  - `filesPanelStore`
  - `projectPullRequestsStore`
  - `webAnnotationPreferencesStore`
  - `lib/pane-selection-storage.ts` (4 `WINDOW_*` keys plus a legacy `STORAGE_KEY`)
- The local-drafts key `orkestrator.web-annotations.local-drafts.v1` (`lib/web-annotations/local-drafts.ts:13`) has no namespace.
- Browser and iOS realms already used the `:machine:<hash>` form in shared origin storage, so new per-node keys read existing data. Desktop realm data lives in per-realm partitions and is abandoned (13.7 A).
- There is no IndexedDB anywhere in the web app (relevant to [4003](4003-snapshot-first-rehydration.md), not here).

## Work

- [ ] `desktopConnectionStorageKey(base, nodeId)`. The command node's key equals today's key, so nothing moves for it.
- [ ] Namespace the local-drafts key by node. Existing data belongs to the command node.
- [ ] A small per-key migration table, used by the store items as they convert.

## Tests

- [ ] The command node's key is unchanged; a leaf's key equals the key a browser realm wrote for it; local drafts migrate once.

## Done when

- [ ] Every key listed above takes a node id.
