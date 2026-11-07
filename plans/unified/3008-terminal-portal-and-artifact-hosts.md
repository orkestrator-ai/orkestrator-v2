---
id: 3008
title: "Node-qualified terminalPortalStore and artifactLiveHostStore"
phase: 3
plan: "§7.1 class (d) and §12 Phase 3.3"
status: done
depends_on: [3001, 3016]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 3008 · Node-qualified terminalPortalStore and artifactLiveHostStore

- **Report:** [§5.1](../../docs/reports/unified-federation.md#51-scopes) (the terminal DOM registry is window-owned), [§7.1](../../docs/reports/unified-federation.md#71-inventory)
- **Depends on:** [3001](3001-scoped-store-shim-and-ratchet.md), [3016](3016-rich-content-and-caches.md) (`artifactLiveHostStore` imports `rich-content-reset`)
- **Blocks:** [3010](3010-sessions-terminals-tmux-mail.md), [3013](3013-pane-layout-store.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

The terminal DOM registry and live artifact hosts stay window-owned, because a DOM node exists once per window. Their keys carry the node, because terminal keys use host-local container ids that can repeat across nodes.

## Current state (verified 2026-11-07)

- `terminalPortalStore`: 368 LOC, 6/4 imperative sites. `paneLayoutStore` calls it.
- `artifactLiveHostStore`: 364 LOC, 5 sites. It imports `rich-content-reset`.

## Work

- [x] Change keys to `{ nodeId, key }`, encoded as `${nodeId}\u0000${key}` or a nested map. Every producer passes the scope's node id.
- [x] Byte-bounded artifact hosts reserve from the window `ByteBudget` ([2001](2001-node-scope-core.md)) with node-qualified keys.
- [x] Disposing a scope releases its terminal portals and artifact hosts.

## Tests

- [x] Two nodes with the same container-derived terminal key get two portals, and disposing one node releases only its own.

## Done when

- [x] Both stores are node-qualified, and the existing terminal and artifact suites pass.

## Notes

- **API (2026-11-07).**
  - `stores/terminalPortalStore.ts`: every key is `{ nodeId, key }` encoded `${nodeId}\u0000${key}`. `createTerminalKey(nodeId, environmentId, tabId)`, `createPortalTargetKey(nodeId, environmentId, paneId)`. `PersistentTerminalData.nodeId` and `CreateTerminalOptions.nodeId` are required. Every action takes `nodeId` first: `registerPaneHost`, `unregisterPaneHost`, `getPaneHost`, `getTerminal`, `hasTerminal`, `setTerminalPane`, `disposeTerminal`, `clearTerminalsForEnvironment`, `markTerminalOpened`, `setTerminalContainer` and `recreateTerminal`. `createTerminal` takes it in its options. New: `clearTerminalsForNode(nodeId)`, which disposes the node's xterm instances, detaches their portal elements and forgets its pane hosts. `bindTerminalPortalsToScope(scope) → BackendId` registers that release once per scope with `scope.onDispose("terminal-portals", …)`. `useTerminalPortalNodeId()` returns the nearest scope's node id (`useScopesWithCommandFallback`) and binds it in a layout effect, which runs before the producer's own layout effects. `commandTerminalPortalNodeId()` returns the command scope's node id. `TerminalPortalState` is exported.
  - Producers: `TerminalPortalHost` and `PaneLeafContainer` use `useTerminalPortalNodeId()`. The portal host renders and disposes only its own node's terminals, and its React keys are the node-qualified terminal key. `PersistentTerminal` uses `terminalData.nodeId`. `paneLayoutStore` (5 sites: `cleanupLocalTabResources`, `reset`, `closeTab` twice, `closePane`) passes `commandTerminalPortalNodeId()`, because the pane layout is still the command node's singleton. [3013](3013-pane-layout-store.md) changes those calls to `scope.nodeId` when it scopes the store.
  - `stores/artifactLiveHostStore.ts`: `LiveArtifactTarget.nodeId`, `LiveArtifactRequest = Omit<LiveArtifactTarget, "nodeId">`, `LiveHostEnded.nodeId`. Changed signatures: `request(owner: NodeScope, target: LiveArtifactRequest)`, `registerAnchor(owner: NodeScope, occurrenceKey, element)`, `clearEnded(nodeId, occurrenceKey)`. New: `releaseNode(nodeId)`, `liveAnchorKey(nodeId, occurrenceKey)`, `isLiveOccurrence(entry, nodeId, occurrenceKey)`, `artifactLiveHostOwner(nodeId) → NodeScope | null` and `LIVE_HOST_BUDGET_NAME`. `ArtifactLiveHostState` is exported. A request or anchor binds its scope once (`onDispose("artifact-live-host", …)`). The live session opens and closes on the owner's client through `backendApiForScope(owner, createTranscriptArtifactsApi, …)`, which gives the named exports on the app command scope, so the suites' `invoke` mock still sees those calls. A disposed scope never becomes an owner, so its target ends in the error phase ("This machine is no longer connected.").
  - Saved preview bytes: a held target's `previewDataUrl` reserves its length from `owner.budgets.artifacts` under `(nodeId, "artifact-live-host\u0000<n>")`. If the budget refuses, the preview is dropped and the view still starts. An eviction strips the preview from the active or pending target. The reservation is given back on stop, invalidate, switch, cancel, node release and `resetForTests`. `ByteBudget` never evicts the shown node.
  - Readers: `ArtifactPartBodies` and `ArtifactLivePlaceholder` match occurrences by `(their scope's nodeId, occurrenceKey)` and pass their scope to `request` and `registerAnchor`. `ArtifactLiveHost` renders the surface inside `NodeScopeProvider scope={owner}`, so `useTranscriptArtifactCapabilities` and the "backend changed" check read the target's node, not the command node. Before this change, a leaf node's view would have been invalidated at once. The protected-cache `clearBackend` also matches `target.nodeId`, so 3016's alias resolution reaches a view accounted to a node id.
- **Decision: window-owned stores with node-qualified keys, not scoped stores (2026-11-07).** Options:
  - (a) `defineScopedStore` per node. Each node would get its own DOM registry and its own live host, which breaks "one live host per window" (`liveExecutableHostsPerWindow`) and the report's §5.1 placement of the terminal DOM registry in the `WindowScope`.
  - (b) A store owned by the `WindowScope` object. That means editing 2001's `window-scope.ts`, and every reader would need the window scope threaded to it.
  - (c) Keep the module zustand stores (one per renderer, which is one per window) and qualify every key by node, as 3017 did for the class (b) stores.

  Chosen: (c). Neither store is registered in `SHIMMED_STORES`, because neither is a scoped store, so the `scoped-store-shim` and `lib-backend-command-default` guards do not count them and no baseline changes. The 6 terminal-portal and 5 live-host imperative sites stay `getState()` calls on the window store, now with node ids.
- **Decision: how a dispose finds the store (2026-11-07).** Options: (a) watch `windowScope.nodeScopes` for closed scopes; (b) the producer binds its own scope with `scope.onDispose`. With (a), the module store would have to pick a window scope, and tests render under their own `WindowScope`s, not the app's. Chosen: (b), idempotent per scope through a `WeakSet`. The live host's finalizer runs before the scope's client is disposed (finalizers run last in, first out), so the session close still reaches the node.
- **Decision: the preview is the only byte-bounded host data (2026-11-07).** The live document runs out of process (desktop `WebContentsView`) or in an opaque iframe, so its memory is not the renderer heap's. The renderer holds the saved capture (`previewDataUrl`, a base64 PNG) for as long as the view is active or pending, so that is what reserves. The size is the string's length, matching 3016's estimate for ledgers.
- **Left unchanged.** `useLiveHostScopeGuard` in `ArtifactLiveHost.tsx` still compares against the command node's `environmentStore` and `uiStore`. Those are [3004](3004-project-and-environment-stores.md)'s and [3006](3006-ui-store-split.md)'s (the `[environment] ArtifactLiveHost.tsx` shim findings at lines 190 and 217 are 3004's). Once selection is node-qualified, the guard should compare `active.target.nodeId` too. `VirtualizedMessageList`'s "live artifact expanded" pause stays window-wide: an expanded view covers the window whatever node it belongs to.
- **Test-isolation fix.** `PersistentTerminal.test.tsx` mocked `@/stores/terminalPortalStore` and never restored it, so `TerminalContainer.notes.test.tsx` failed when the two ran in one process (`registerPaneHost is not a function`). It now restores a snapshot in `afterAll`.
- **Effect (2026-11-07): not used.** Both stores are synchronous zustand state read during render. Scope lifetimes (Effect `Scope`s from 2001) are used only through `scope.onDispose`, and the byte bound is 2001's `ByteBudget`.
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): node-qualified keys in `terminalPortalStore`, plus `clearTerminalsForNode`, `bindTerminalPortalsToScope`, `useTerminalPortalNodeId` and `commandTerminalPortalNodeId`. Producers updated: `TerminalPortalHost`, `PaneLeafContainer`, `PersistentTerminal`, and `paneLayoutStore`'s 5 sites, which use the command node. `artifactLiveHostStore`: node-qualified targets, anchors and ended notes; sessions on the owner scope's client; preview bytes reserved from the window `artifacts` budget; per-node release on scope dispose. `ArtifactLiveHost` renders the surface inside the owner's node scope. Tests:
  - New `terminalPortalStore.test.ts` cases (4): two nodes with the same container-derived key get two portals and two pane hosts; disposing one node releases only its own; an environment clear is per node; the producer hook keys by its scope and is released on dispose.
  - New `artifactLiveHostStore.test.ts` (9): the session on the asking node; the same occurrence on another node switches; anchors per node; dispose releases only that node's host, anchors and preview; a disposed scope cannot start a view; the preview reservation is released on stop, cancel and switch; a refused preview; eviction except of the shown node.
  - `ArtifactLiveHost.test.tsx` +1: a leaf view runs on the leaf's client, reads the leaf's capabilities, and is released when the leaf is disposed.

  Existing suites updated for the new signatures. Focused run (`terminalPortalStore`, `artifactLiveHostStore`, `paneLayoutStore`, `components/terminal`, `components/pane-layout`, `components/chat`, `lib/chat`): 3,221 pass, 0 fail, 174 files. Web typecheck: no errors in touched files (other agents' in-progress errors elsewhere). fmt and oxlint are clean on the touched files; `oxlint apps/web/src` reports no `import/no-cycle` finding. `tests/unit/source-guards.test.ts`: no finding for this item's changes. Its failures are 3004's `[environment]` entries (including `ArtifactLiveHost.tsx`'s two `useEnvironmentStore` calls, unchanged here) and an unregistered store from another item.
