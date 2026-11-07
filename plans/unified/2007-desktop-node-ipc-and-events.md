---
id: 2007
title: "Desktop: node-tagged invoke, events and preload API"
phase: 2
plan: "§6.3 B, C, G and §6.4"
status: done
depends_on: [2006]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] `orkestrator:invoke(command, args, options?: { nodeId?, envelope? })`. An absent `nodeId` means the command node. (`envelope` comes from [1003](1003-backend-register-overload.md); coordinate whichever lands first.)
- [x] `getBackend(event, nodeId?)`:
  - awaits `ensureNodeScope` and `noteUse` for that node scope;
  - refuses administration commands for a leaf `nodeId`, replacing the `context.target` check with a node check that has the same command list;
  - a `nodeId` for a node the window cannot reach (unknown to the command node) is refused with a coded error.
- [x] `orkestrator:nodes:open(nodeId)`, `orkestrator:nodes:release(nodeId)` and `orkestrator:nodes:gateway(nodeId)`. The last returns a per-node snapshot with no credentials.
- [x] Events: `orkestrator:node-event (nodeId, event, payload)`. `sendToConnection` maps a node scope's connection id to `(window, nodeId)`. `orkestrator:event` stays for the command node. `native-event-stream-connected` is emitted per node.
- [x] Node scopes keep terminal output on (`relayTerminalOutput` true) and tag it by node.
- [x] Preload: `node(nodeId) → { invoke, listen, eventStreamReady, eventStreamConnection }`. It demultiplexes `orkestrator:node-event` by `nodeId` with one IPC listener per window, not one per node.
- [x] Keep the realm IPC (`workspace-views:*`, `workspace-realm:post`, `portal:invoke`) alongside until [6003](6003-delete-desktop-realm-code.md).

## Tests

- [x] An event for node B never reaches a node-A listener; a window-close mid-open leaves no scope; admin refusal by `nodeId`; an older two-argument invoke still works.
- [x] `preload-api.test.ts` covers `node(nodeId)` demultiplexing and unlisten.

## Done when

- [x] A test renderer can invoke and listen on two nodes at once through main.

## Notes

- API. Main: new `apps/desktop/electron/node-ipc.ts`, `DesktopNodeIpc<W>` (one per main process, `nodeIpc` in `main.ts`) with `backendFor(context, nodeId)`, `open(context, nodeId, { hold? })`, `openForRenderer`, `release`, `gateway(context, nodeId) → NodeGatewaySnapshot | null`, `adminScope(context, nodeId?)`, `isCommandNode`; constants `NODE_EVENT_CHANNEL` (`orkestrator:node-event`) and `NODE_SCOPE_RELEASED_EVENT`; `NodeRefusal`, `nodeRefusal(code, text)`, `parseNodeId`. `ipc.ts`: `parseInvokeOptions`, `InvokeOptions`, `MAX_INVOKE_ENVELOPE_LENGTH` (4096), `MainIpcDependencies.getBackend(event, nodeId?)` (may return a promise) and `nodes?: { open, release, gateway }`. `DesktopWindowContexts.mapNodeConnection(context, nodeId, connectionId) → unmap`. Preload: `invoke(command, args, options?)`, `node(nodeId) → { nodeId, invoke, listen, eventStreamReady, eventStreamConnection }`, `nodes: { open, release, gateway }`, `createNodeApis`, `NODE_EVENT_CHANNEL`, and `webClient.*(…, options?: { nodeId })`.
- Invoke shape (agreed with [1003](1003-backend-register-overload.md)): `orkestrator:invoke(command, args, options?: { nodeId?, envelope? })`. `envelope` is accepted as an opaque plain object of at most 4096 JSON characters and passed to the backend invoker as a third argument `{ envelope }`, only when present (an older two-argument call reaches the invoker exactly as before). Main's `ConnectionManager` boundary drops it for now; 1003 carries it on the backend client and parses it. The command is validated before the node is resolved, so a malformed call never opens a scope.
- Routing. A `nodeId` equal to the window's command node (its proved `backendId`) uses the window's own scope and opens nothing. Any other `nodeId` goes through `ensureNodeScope` (which also does `noteUse`). Node scopes are refused for a realm sender ("Only a window can open other machines' scopes."): a realm is already another node and goes away in [6003](6003-delete-desktop-realm-code.md).
- Coded refusals: `unknown-node`, `node-admin-refused`, `node-scope-closed` (window closed or scope released while opening), `node-unavailable` (known node whose workspace did not open; the backend's message follows). Electron passes only an error's `message` over IPC and the context bridge drops custom properties, so the message leads with `[code] ` and the preload also sets `error.code` from it (options: a result envelope instead of a rejection, which would change every caller; a separate error channel, more machinery; the message prefix, chosen). Renderer code that crosses the bridge reads the code from the message (`/^\[([a-z][a-z0-9-]{0,63})\] /`); 1002's `incompatibility(error)` reader or [2010](2010-command-scope-wiring.md) may want to read this form too.
- Unknown node: before the first open in a window, main reads `list_nodes` on the command scope and refuses a node not in it, before any grant is asked for. A list that cannot be read (older or busy command node) decides nothing; the open then reports why.
- Administration: the five machine-administration IPC handlers (`web-client:get-status|set-enabled|reset-serve|get-token-settings|set-token`, the list `machineAdminScope` guarded) accept a trailing `{ nodeId }`; a leaf is refused with `node-admin-refused` and opens no grant. The realm-era `context.target` refusal is kept, with its message unchanged, until 6003. Backend administration commands sent through a node scope are still refused server-side by the grant (`workspace-grant-scope.ts`), as the report's §10.1 says; main does not keep a second list.
- Events: a node scope's connection is mapped to `(window contents, nodeId)` once its open settles, and `sendToConnection` sends that connection's events as `orkestrator:node-event (nodeId, event, payload)`; `orkestrator:event` is untouched. Per-node relayed events are not passed on node channels (a node scope never asks for them). Terminal output needs nothing new: workspace clients are created with `relayTerminalOutput` true and only the Local backend's relay is ever toggled, so it arrives on the node's stream and is tagged by the channel.
- `native-event-stream-connected` per node: the node's own stream frames pass through, and main also sends one when the scope is first wired, because frames that arrived before the mapping were not delivered (the same reason a window gets one on every `did-finish-load`).
- Release: a release (explicit, window close, command-node change, idle, and new: window reload, below) sends `node-scope-released { nodeId }` on the node channel; the preload marks the node `disconnected` and the next `listen`/`eventStreamReady` reopens it. New trigger: `did-navigate` releases the window's node scopes, as it closes its realms, because a reloaded document no longer holds them (holds would otherwise keep them open forever while idle is "never").
- Preload: one `ipcRenderer.on(NODE_EVENT_CHANNEL)` per renderer, registered on the first `node()` call, demultiplexed by `nodeId`. `node(id)` returns the same handle per node. `listen` and `eventStreamReady` open the node once (one `nodes:open`, one hold) and again after a release; `invoke` opens through `getBackend` without a hold. `eventStreamConnection` reports `idle | connecting | connected | disconnected` (the same names as the gateway's `GatewayEventStreamConnectionState`), driven by main's frames. Per-node relayed listens (`eventStreamReady` for `relayed-node-event:*`) stay a command-node feature. `node(commandNodeId).listen` receives nothing: command-node events stay on the top-level `listen`; 2010 should route the command node to the top-level API.
- `nodes:gateway(nodeId)`: `{ nodeId, commandNode: false, nodeName, path, routeKind?, via?, baseUrl, backendId, backendOnThisDevice }` for an open node scope, `{ nodeId, commandNode: true, baseUrl, backendOnThisDevice }` for the command node, null while not open. No token or authorization. `nodes:open` answers the same snapshot.
- Realm IPC (`workspace-views:*`, `workspace-realm:post`, `portal:invoke`) unchanged.
- Effect: `NodeRefusal` is a `Data.TaggedError` (typed, `_tag`-discriminated, an `Error` for IPC). The event mapping's teardown and the renderer's release notice are registered with `onNodeScopeRelease`, i.e. as finalizers of the node scope's Effect `Scope`, so they run on every release path (and at once if the scope already closed) before the grant is revoked; no new lifetime machinery. Not used: the IPC handlers and `DesktopNodeIpc` are plain async (a single await chain each, called from Electron's promise handlers), and the preload has no Effect at all (it is a sandboxed CommonJS bundle; `electron-bundle.test.ts` passes).
- Files outside the listed set: `apps/desktop/electron/desktop-window-contexts.ts` (the mapping and delivery live in `sendToConnection`) and the new `node-ipc.ts`. `federation-ipc.ts` unchanged.
- Done when: the test drives the real `registerMainIpc` handlers, preload API, `DesktopWindowContexts`, `DesktopNodeScopes` and `NodeWorkspaceScopes` over an in-memory IPC with a fake connection manager; `main.ts`'s wiring is typechecked but not run (this worktree's Electron binary cannot start). Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added `node-ipc.ts` (node-addressed invoke, coded refusals, open/release/gateway, event wiring through `onNodeScopeRelease`), node event delivery in `DesktopWindowContexts`, `orkestrator:invoke` options and `orkestrator:nodes:*` in `ipc.ts`, the preload's `node(nodeId)`/`nodes`, and the `main.ts` wiring (including release on reload). Tests: new `apps/desktop/tests/node-ipc.test.ts` (12) and five new `preload-api.test.ts` cases; with `main-ipc`, `desktop-window-contexts`, `node-scopes`, `federation-ipc`, `window-workspace-target`, `node-workspaces`, `workspace-views`, `realm-contexts` and `electron-bundle`, 203 pass. Desktop typecheck and `oxlint` clean.
