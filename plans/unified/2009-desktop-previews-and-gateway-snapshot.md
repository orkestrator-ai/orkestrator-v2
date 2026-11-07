---
id: 2009
title: "Desktop: preview runtime per node scope and per-node gateway snapshot"
phase: 2
plan: "§6.3 E and F"
status: done
depends_on: [2007]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 2009 · Desktop: preview runtime per node scope and per-node gateway snapshot

- **Report:** [§6.3 E, F](../../docs/reports/unified-federation.md#63-desktop)
- **Depends on:** [2007](2007-desktop-node-ipc-and-events.md)
- **Blocks:** [2013](2013-second-scope-proof.md), [4006](4006-multi-node-qualification.md) (preview z-order)
- **Size:** M
- **Track:** S (scopes), desktop lane

## Goal

A preview tab for a leaf, opened from the window renderer, runs through that node's preview runtime. The renderer can tell, per node, whether the backend is on this device.

## Current state (verified 2026-11-07)

- Preview IPC channels are named `orkestrator:browser-preview:*` (not `browserPreview:*` as the report says).
  - The handlers are in `ipc.ts:489-650`. All of them resolve through `previews(event)` (:484-488) → `getBrowserPreviews` (main.ts:1354) → `ipcContextForEvent(event).browserPreviewManager`, which is per renderer.
  - Preload is at `preload-api.ts:699-743`.
- The partition key is already `node:<nodeId>` (main.ts:1182, :1129, :635; `desktop-window-contexts.ts:323`), so preview site data needs no migration.
- `realmChildViewClass` and `RealmLayout` are used only in main.ts (:49, 651, 1121, 1172) and in `workspace-views.ts`.
- The gateway snapshot:
  - main builds it at main.ts:1375-1396;
  - its type is `GatewaySnapshot`, at federation-ipc.ts:36-55;
  - it is served on `orkestrator:connections:gateway-sync`, at :208;
  - preload parses it at preload-api.ts:91-154.
  - It carries the boolean `backendOnThisDevice` (`isScopeOnThisDevice`, connection-manager.ts:1174).
  - **`localInstallationId` does not exist.** The source would be `connectionManager.localHello?.installationId` (:1152).
- Callers of `isRemoteGatewayConnection` and `isBackendOnAnotherDevice` (6 files): `AgentInfoButton.tsx`, `useActionBarController.ts`, `AgentNativeTab.controller.tsx`, `OpenCodeProviderSignIn.tsx`, `GlobalSettings.sections.tsx` and `preview-link-external.ts`.

## Work

- [x] Preview runtime per node scope, created on the first `attach` that carries a `nodeId`. Main keeps `tabId → runtime`, and every `orkestrator:browser-preview:*` handler resolves the runtime through the tab, not the renderer.
- [x] Bounds are window coordinates for node-scope previews; no `RealmLayout` offset.
- [x] Add `localInstallationId` to the gateway snapshot. Add `backendOnThisDevice(nodeId)` and `isBackendOnAnotherDevice(nodeId)` on the web side. The 6 callers take the node from the scope, or default to the command node until their store is scoped.
- [x] Note the z-order and focus risk with several managers adding views to one window. It is tested in [4006](4006-multi-node-qualification.md).

## Tests

- [x] Two preview tabs for two nodes in one window resolve to two runtimes with the right partitions, and a detach releases the runtime.
- [x] `backendOnThisDevice(nodeId)` is true only for `localInstallationId`.

## Done when

- [x] A desktop test shows a leaf preview attached through the window renderer with the leaf's partition.

## Notes

- API, main (`apps/desktop/electron/node-previews.ts`): `NodePreviewRuntimes<W, C>` (one per main process, `nodePreviews` in `main.ts`) with `forAttach(context, tabId, nodeId?)`, `forTab(context, tabId)`, `forNode(context, nodeId?)`, `destroy(context, tabId)`, `runtimeOf(record)`, `runtimes(context)`; `NodePreviewRuntime<C> { controller, partition, partitionsInUse(), dispose() }`; `nodePreviewPartitionKey(nodeId)` (`node:<nodeId>`); `routeBrowserPreviews(runtimes, { window, nodeWindow })`, which builds `ipc.ts`'s new `BrowserPreviewRouting { forAttach, forTab, forNode, destroy }` (`MainIpcDependencies.browserPreviewRouting`). `main.ts` adds `createNodeBrowserPreviews(context, record, partitionKey)`, the runtime factory.
- Routing. `tabId → runtime` is kept per window (a `WeakMap` keyed by the window context); a tab main does not know is the window's own runtime (the command node's), so a renderer that never sends `nodeId` behaves exactly as before. `attach` takes an optional `nodeId` (`BrowserPreviewAttachInput.nodeId` in `packages/protocol/src/browser-preview.ts`; validated with `parseNodeId` before anything opens, and not passed on to the manager); the command node's own id means the window's runtime. Every handler that names a tab resolves through the tab: set-bounds, set-visible, navigate, back, forward, reload, devtools, session import start/dismiss, open-sign-in, capture start/status/cancel, pins show/clear/results, show-on-page, responsive set, destroy. Handlers keyed by a pending capture id (list/read/replace-image/ack/discard/receipt, expired list/dismiss, capabilities, diagnostics) stay on the window's runtime: the capture spool is one shared store (`browserPreviewCaptureStore()`), so any runtime reads the same captures (the diagnostics' anchor-resolution counts are the window runtime's only). The two service calls without a tab (`reset-site-data`, `open-external`) take an optional trailing `{ nodeId }`, also exposed in the preload (`resetServiceSiteData(target, { nodeId })`, `openServiceExternally(target, { nodeId })`); without it they are the window's, as before.
- Runtime. Created on the first attach (or node-named service call) for a node in a window, on that window's node scope (`nodeIpc.open`, so an unknown node is refused with `unknown-node` before a grant is asked for, and a realm sender is refused as for other node calls). It is `createWindowBrowserPreviews` with the node scope's scope (request authorization, client key), the node scope's connection (service tunnel), the partition key `node:<nodeId>` (so partition `persist:orkestrator-browser-previews-<slot>-<hash(node:<id>)>`, the same as a realm's in that slot: no migration), the window's renderer as owner (events), and plain `WebContentsView` (window coordinates, no `realmChildViewClass`/`RealmLayout`). It is remembered for partition retention (`rememberPreviewNode`), and its partitions are counted as in use. Main's retention uses the transport only (as realms do), not the command node's `list_nodes`.
- Lifetime, and where Effect is used. A runtime holds its node scope (one `holds` count) while it shows at least one tab, so a future idle budget (4002) does not close a scope under a visible preview. Destroying its last tab disposes it (`destroyAll` + `disposeAll`) and drops the hold; the next attach makes a fresh one. A tab moved to another node is destroyed on the first. The node scope's release (explicit, idle, window close or reload, command-node change) disposes the runtime through `onNodeScopeRelease(record, …)`: a finalizer on the scope's Effect `Scope`, registered once per record, so it runs on every release path, at once if the scope is already closed, and (finalizers run in reverse) before 2007's event unmapping and before the grant is revoked (asserted in the test). No other Effect: the routing is synchronous bookkeeping over the existing promise-based IPC handlers.
- Hold accounting writes `record.holds` directly rather than through `DesktopNodeScopes.dropNodeScopeHold(context, nodeId)`: that looks the record up by node, and after a release and reopen it would decrement the new scope's count. Options: a hold API on `DesktopNodeScopes` keyed by record (more surface for one caller) or the direct write on the record the runtime belongs to (chosen).
- Z-order and focus (inferred risk, tested in [4006](4006-multi-node-qualification.md)): every node runtime adds its views to the same window `contentView` as the window's own previews, artifact hosts and realm views. A view added later is drawn above the others and nothing orders views across runtimes; focus moves to whichever view is clicked, and keyboard shortcut routing uses each runtime's own `webContentsIdForTab`. The renderer shows one preview tab per region, which limits overlaps to tabs it hides. Also during the transition: a realm and a node scope runtime for the same node in the same window share a partition, so the later one's request-auth hook replaces the earlier one's on that session (Electron keeps one `webRequest` listener per event); realms go in [6003](6003-delete-desktop-realm-code.md).
- Not done here: a committed rebind of a node scope (relay to direct) keeps the runtime; service previews follow the tunnel, but an address-bar preview still requests the old gateway origin until the renderer reattaches (realms reload instead). The renderer receives `node-scope-changed` and can reattach once it creates node previews (no web caller passes `nodeId` yet; `apps/web/src/lib/native/browser-preview.ts` is left to [2010](2010-command-scope-wiring.md)'s owner).
- Gateway snapshot: `GatewaySnapshot.localInstallationId?: string | null` (`federation-ipc.ts`), from the new `ConnectionManager.localInstallationId()` (`localHello?.installationId`, which `isScopeOnThisDevice` now uses too). The preload parses it and exposes it as `window.orkestratorDesktopIdentity.localInstallationId` rather than on `orkestratorGateway`, because a local window has no gateway object but always has the identity (options: the gateway object, missing on Local; a new global, more surface; the identity, chosen). It is an installation identity, never a credential. The snapshot stays the command node's; 2007's per-node `nodes:gateway` is unchanged.
- Web (`apps/web/src/lib/gateway-url.ts`): `DeviceCheckNode` (a scope `{ nodeId, role }`, a node id, or nothing for the command node), `localInstallationId()`, `backendOnThisDevice(node?)`, `isBackendOnAnotherDevice(node?)` (`!backendOnThisDevice`), and `isRemoteGatewayConnection(node?)`. A leaf is on this device exactly when its id equals `localInstallationId`; a leaf is always "through a gateway". The command node (no argument, a `command` scope, its provisional id, or the window's proved `backendId`) compares its proved id with `localInstallationId` when both are known, and otherwise keeps today's rule (no or loopback gateway is this computer; a desktop gateway is unless main's `backendOnThisDevice` says so), so every current answer is unchanged. Passing a scope rather than an id keeps the command node recognisable after [2010](2010-command-scope-wiring.md) gives it its proved id.
- The 6 callers: `AgentInfoButton.tsx`, `AgentNativeTab.controller.tsx`, `OpenCodeProviderSignIn.tsx` and `useActionBarController.ts` pass the scope they render in (`useScopesWithCommandFallback().scope`, from 3017; the command scope until their stores are scoped). `GlobalSettings.sections.tsx` (it describes the command node's gateway, as `getGatewayBaseUrl()` does) and `preview-link-external.ts` (plain code reading the command node's environment store) keep the command-node default, with a comment.
- Files outside the listed set: `apps/desktop/electron/connection-manager.ts` (the one getter), `apps/desktop/electron/node-scopes.ts` (a doc comment on `previewRuntime`), `packages/protocol/src/browser-preview.ts` (`nodeId` on the attach input). `ipc.ts`: only the browser-preview handlers and the dependency type; the invoke handler is untouched. `main.ts`: the `nodePreviews` instance, the runtime factory, the retention line, the routing dependency and the snapshot field.
- Done when: `apps/desktop/tests/node-previews.test.ts` drives the real preload API, `registerMainIpc` handlers, `DesktopWindowContexts`, `DesktopNodeIpc`, `DesktopNodeScopes`, `NodeWorkspaceScopes` and `NodePreviewRuntimes` over an in-memory IPC with a fake connection manager; the runtime factory is a fake that computes the partition with main's `browserPreviewPartitionForWindow` (Electron's views and sessions cannot start in this worktree). `main.ts`'s factory is typechecked, not run. Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added `node-previews.ts` (per-node preview runtimes, `tabId → runtime`, release through `onNodeScopeRelease`), tab-routed `orkestrator:browser-preview:*` handlers in `ipc.ts`, `nodeId` on attach and on the two service calls (protocol and preload), the `main.ts` runtime factory and wiring, `localInstallationId` in the gateway snapshot and the preload identity, and the web `backendOnThisDevice(node)`/`isBackendOnAnotherDevice(node)`/`isRemoteGatewayConnection(node)` with the 6 callers. Tests: new `apps/desktop/tests/node-previews.test.ts` (9), a preload identity case, two `localInstallationId` assertions in `connection-manager-federation.test.ts`; with `main-ipc`, `node-ipc`, `node-scopes`, `federation-ipc`, `desktop-window-contexts`, `connection-manager`, the browser-preview manager/service/startup suites, `preview-partition-retention`, `workspace-views`, `realm-contexts`, `window-workspace-target`, `node-workspaces` and `electron-bundle`, 417 pass. Web: four new `gateway-url.test.ts` cases; with the callers' suites 994 pass, 2 fail (`ActionBar` "keeps the newest ActionBar launch focused…" and `openLinkExternally` "forwards a remote terminal link…", both `api.listen is not a function` in `lib/node-scope/command-client.ts`, which another agent is changing in the working tree; not these changes). Desktop, web and protocol typecheck clean; `oxlint` clean.

