---
id: 3015
title: "Persistence keys take a nodeId"
phase: 3
plan: "§7.5 and §12 Phase 3.8"
status: done
depends_on: [2001]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] `desktopConnectionStorageKey(base, nodeId)`. The command node's key equals today's key, so nothing moves for it.
- [x] Namespace the local-drafts key by node. Existing data belongs to the command node.
- [x] A small per-key migration table, used by the store items as they convert.

## Tests

- [x] The command node's key is unchanged; a leaf's key equals the key a browser realm wrote for it; local drafts migrate once.

## Done when

- [x] Every key listed above takes a node id.

## Notes

- **API (2026-11-07).** `lib/desktop-storage-key.ts`: `StorageNode { nodeId: BackendId; role: NodeScopeRole }` (a `NodeScope` is one), `COMMAND_STORAGE_NODE` (the command node under `COMMAND_SCOPE_PROVISIONAL_NODE_ID`), `desktopConnectionStorageKey(baseKey, node)`, `isBrowserLeafRealm()`. *(2026-11-07, orchestrator, completeness check: `isBrowserLeafRealm` was removed with the realms by [6002](6002-delete-web-realm-code.md); `persistence-keys.test.ts` has 6 tests at HEAD, not the 7 the Work log counts.)* New `lib/persistence-keys.ts`: `nodeStorageKey(baseKey, node)` (the key plus any one-time move; what stores should call), `PERSISTENCE_KEY_MIGRATIONS` (base key → `{ legacyKeys, removeLegacy }`), `migratePersistenceKey(baseKey, targetKey, storage?, table?)`, `LOCAL_DRAFTS_STORAGE_KEY`; it re-exports `StorageNode` and `COMMAND_STORAGE_NODE`.
- **Decision: the key takes the node's id and role, not a bare id.** Options: (a) a bare `nodeId`, deciding "is this the command node" by comparing with the app window scope's command scope; (b) `{ nodeId, role }`. (a) matches the item's wording but hides a global lookup, and breaks for scopes in a test window scope (`renderInNodeScope` opens its command scope as `bk_fake-node` in its own `WindowScope`), and the command id changes when 2010 proves it. (b) needs nothing global; callers pass their `NodeScope`. Chosen: (b). The command node's key ignores the id, so it is the same before and after 2010.
- **Key shapes.** Command node: exactly today's key (browser: the base key, or the `:machine:` key in a hosted-browser realm on a leaf; desktop: the `:desktop:<identity>` key with its existing adoptions). Leaf: `<base>:machine:<hash("machine:"+nodeId)>` in every renderer, the key a browser or iOS realm on that leaf wrote. On desktop that form is new; the old realm partitions are abandoned (13.7 A). A leaf key never adopts the un-namespaced legacy value (that is the command node's).
- **Local drafts.** The key is now `orkestrator.web-annotations.local-drafts.v2`, namespaced per node; the v1 key is the one entry in the migration table: moved into the command node's key once (a marker `<base>:node-keys-migrated-v1` records it), then deleted. A target that already holds data wins. A hosted-browser realm on a leaf does not migrate, so the page's v1 copy stays for the page's own command node. `readLocalDraft`, `writeLocalDraft` and `clearLocalDraft` take a trailing `node` (default command node).
- **Callers.** `filesPanelStore`, `projectPullRequestsStore` and `webAnnotationPreferencesStore` pass `COMMAND_STORAGE_NODE` explicitly to `nodeStorageKey`; `legacy-local-state.ts`, `createUIStateStorage` and every exported `pane-selection-storage.ts` function take a trailing `node`/`storageNode` defaulting to the command node, so today's callers (owned by 3006, 3007, 3012, 3013) are unchanged and pass their scope when they convert. The legacy un-namespaced `orkestrator.pane-selection.v1` record is command-only: `readStoredPaneSelection`/`clearStoredPaneSelection` return nothing for a leaf. The hook callers of the local drafts (`useAnnotationDraft`, `AnnotationEditor`) still use the default: `useNodeScope()` throws outside a provider in tests, and their many harness tests are web-annotation (3012) territory.
- **Effect.** Not used: these are synchronous string derivations and `localStorage` moves that Zustand's `persist` reads at module evaluation.
- **Follow-up for the orchestrator.** `docs/architecture/federation.md` "Storage namespacing" still describes the single-identity key; it should mention the node argument and the leaf `:machine:` form (not edited here, outside this item's file set).
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): `desktopConnectionStorageKey(base, node)`, `persistence-keys.ts` (migration table, `nodeStorageKey`), node-namespaced local drafts (v1 → v2 for the command node, once), node parameters on legacy-local-state, ui-state-storage and pane-selection-storage, and the three persisted stores. Tests: `desktop-storage-key.test.ts` (3 new), `persistence-keys.test.ts` (7 new), plus the existing users (284 pass across 24 files: annotations, uiStore persistence, workspaces, coordinator upstream check, CoordinatorPanel, pane selection, files panel, project PRs). Web typecheck and oxlint clean.
- 2026-11-07 (orchestrator, completeness check): noted `isBrowserLeafRealm` is gone (6002) and `persistence-keys.test.ts` has 6 tests now.
