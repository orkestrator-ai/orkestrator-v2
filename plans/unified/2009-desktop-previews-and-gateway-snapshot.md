---
id: 2009
title: "Desktop: preview runtime per node scope and per-node gateway snapshot"
phase: 2
plan: "§6.3 E and F"
status: not-started
depends_on: [2007]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Preview runtime per node scope, created on the first `attach` that carries a `nodeId`. Main keeps `tabId → runtime`, and every `orkestrator:browser-preview:*` handler resolves the runtime through the tab, not the renderer.
- [ ] Bounds are window coordinates for node-scope previews; no `RealmLayout` offset.
- [ ] Add `localInstallationId` to the gateway snapshot. Add `backendOnThisDevice(nodeId)` and `isBackendOnAnotherDevice(nodeId)` on the web side. The 6 callers take the node from the scope, or default to the command node until their store is scoped.
- [ ] Note the z-order and focus risk with several managers adding views to one window. It is tested in [4006](4006-multi-node-qualification.md).

## Tests

- [ ] Two preview tabs for two nodes in one window resolve to two runtimes with the right partitions, and a detach releases the runtime.
- [ ] `backendOnThisDevice(nodeId)` is true only for `localInstallationId`.

## Done when

- [ ] A desktop test shows a leaf preview attached through the window renderer with the leaf's partition.
