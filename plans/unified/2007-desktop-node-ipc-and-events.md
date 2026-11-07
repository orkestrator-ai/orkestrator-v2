---
id: 2007
title: "Desktop: node-tagged invoke, events and preload API"
phase: 2
plan: "§6.3 B, C, G and §6.4"
status: not-started
depends_on: [2006]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 2007 · Desktop: node-tagged invoke, events and preload API

- **Report:** [§6.3 B, C, G](../../docs/reports/unified-federation.md#63-desktop), [§6.4](../../docs/reports/unified-federation.md#64-events-must-carry-their-node)
- **Depends on:** [2006](2006-desktop-node-scopes.md)
- **Blocks:** [2009](2009-desktop-previews-and-gateway-snapshot.md), [2010](2010-command-scope-wiring.md)
- **Parallel with:** [2008](2008-desktop-request-auth.md)
- **Size:** M
- **Track:** S (scopes), desktop lane

## Goal

A renderer can name a node on invoke and receives node events tagged with their node. Without a node, everything behaves as today.

## Current state (verified 2026-11-07)

- `ipc.ts` (658 lines) `orkestrator:invoke` (:309-336) calls `getBackend(event)`.
- `main.ts` `getBackend` (:1259-1267) goes through `scopeForEvent` (:1225) → `ipcContextForEvent` (:491) → `contextForEvent` (:479) → `desktopWindows.forEvent` (`desktop-window-contexts.ts:141-147`), and calls `noteUse(scope)`.
- `machineAdminScope` (:1231-1240) throws when `context.target` is set; it is used at :1358-1363.
- `orkestrator:portal:invoke` is registered in `federation-ipc.ts:349-352`, not in main.ts as the report says; main supplies the dependency at :1444-1445.
- `sendToConnection` (`desktop-window-contexts.ts:284-310`) delivers the `"workspace"` channel to the renderer whose scope's connection matches, and the portal channel by `portalScope`. Relayed-listen bookkeeping is at :50-54 and :175-282.
- Terminal output reaches renderers only through main's per-connection stream:
  - `BackendHttpClient.relayTerminalOutput` (`backend-process.ts:491/523`), toggled by `setTerminalOutputRelay` (:560-564);
  - `excludeEvents=terminal-output-` when off (:835-837);
  - workspace clients default to `true` (connection-manager.ts:1240).
- Preload (`preload-api.ts`, 749 lines): `createOrkestratorElectronApi` (:479+) handles `orkestrator:event` and `orkestrator:invoke`.

## Work

- [ ] `orkestrator:invoke(command, args, options?: { nodeId?, envelope? })`. An absent `nodeId` means the command node. (`envelope` comes from [1003](1003-backend-register-overload.md); coordinate whichever lands first.)
- [ ] `getBackend(event, nodeId?)`:
  - awaits `ensureNodeScope` and `noteUse` for that node scope;
  - refuses administration commands for a leaf `nodeId`, replacing the `context.target` check with a node check that has the same command list;
  - a `nodeId` for a node the window cannot reach (unknown to the command node) is refused with a coded error.
- [ ] `orkestrator:nodes:open(nodeId)`, `orkestrator:nodes:release(nodeId)` and `orkestrator:nodes:gateway(nodeId)`. The last returns a per-node snapshot with no credentials.
- [ ] Events: `orkestrator:node-event (nodeId, event, payload)`. `sendToConnection` maps a node scope's connection id to `(window, nodeId)`. `orkestrator:event` stays for the command node. `native-event-stream-connected` is emitted per node.
- [ ] Node scopes keep terminal output on (`relayTerminalOutput` true) and tag it by node.
- [ ] Preload: `node(nodeId) → { invoke, listen, eventStreamReady, eventStreamConnection }`. It demultiplexes `orkestrator:node-event` by `nodeId` with one IPC listener per window, not one per node.
- [ ] Keep the realm IPC (`workspace-views:*`, `workspace-realm:post`, `portal:invoke`) alongside until [6003](6003-delete-desktop-realm-code.md).

## Tests

- [ ] An event for node B never reaches a node-A listener; a window-close mid-open leaves no scope; admin refusal by `nodeId`; an older two-argument invoke still works.
- [ ] `preload-api.test.ts` covers `node(nodeId)` demultiplexing and unlisten.

## Done when

- [ ] A test renderer can invoke and listen on two nodes at once through main.
