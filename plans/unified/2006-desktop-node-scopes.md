---
id: 2006
title: "Desktop main: per-(window, node) scopes"
phase: 2
plan: "§6.3 A and §12 Phase 2.3"
status: done
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 2006 · Desktop main: per-(window, node) scopes

- **Report:** [§6.3 A](../../docs/reports/unified-federation.md#63-desktop)
- **Decision:** 13.5 A (one grant per window and node)
- **Depends on:** none (main-process only)
- **Blocks:** [2007](2007-desktop-node-ipc-and-events.md), [2008](2008-desktop-request-auth.md)
- **Parallel with:** the browser lane, Phase 1
- **Size:** M
- **Track:** S (scopes), desktop lane

## Goal

Main can open a node scope for any node in any window on demand, reusing the grant machinery realms use. Realms are unchanged.

## Current state (verified 2026-11-07)

- `DesktopWindowContext` (`apps/desktop/electron/main.ts:292-315`) has these fields: `window`, `contents`, `scope`, `slot`, `previewConnectionId`, `browserPreviewManager`, `previewTransport`, `artifactHosts`, `portalScope`, `target`, `localGatewayTransport?`, `realm`. The generic record is at `desktop-window-contexts.ts:21-34`.
- `window-workspace-target.ts` (198 lines):
  - `setDesktopWorkspaceTarget` (:26-54) and `applyTarget` (:56-152);
  - scopes `${scope}:portal`, `${scope}:workspace-open`, `${scope}:workspace-retry:<uuid>`;
  - uses `retargetScopeToWorkspace`, `rebindWorkspace` and `restoreScopeFrom` (connection-manager.ts:1216, 1267, 1229);
  - connection id `workspace:<workspaceId>` (`WORKSPACE_CONNECTION_PREFIX`, :157);
  - only caller: main.ts:1107 (the realm `bindScope`).
- `node-workspaces.ts` (369 lines):
  - `openNodeWorkspace` (:72-167): direct, then SSH loopback (desktop only), then relay with the command bearer;
  - `NodeWorkspaceScopes` (:170-369): 5 s tick (:207-220), `noteUse`/`upgrade` (:242-292), `reconcile` (:294-347), `release` (:358-364), `releaseAll`.
- Revoke triggers today:
  - realm view closed (main.ts:1142-1147);
  - window closed (`desktop-window-contexts.ts:125`, wired at main.ts:348);
  - command node changed (`closeWindowRealms`, main.ts:1205-1207);
  - retarget to null (`window-workspace-target.ts:65`).
- The epoch is the command connection's (`window-workspace-target.ts:130`).
- Tests:

| File | Lines |
|---|---|
| `node-workspaces.test.ts` | 470 |
| `window-workspace-target.test.ts` | 310 |
| `desktop-window-contexts.test.ts` | 700 |
| `connection-manager-federation.test.ts` | 1,344 |

## Work

- [x] New `apps/desktop/electron/node-scopes.ts`:
  - `NodeScopeRecord { scope: \`${windowScope}:node:${nodeId}\`, nodeId, target, previewRuntime?, opening, lastUsed, holds }`;
  - `ensureNodeScope(context, nodeId)`: single-flight, reusing `applyTarget`'s open logic without the portal scope;
  - `releaseNodeScope(context, nodeId)`.
- [x] `DesktopWindowContext.nodes: Map<nodeId, NodeScopeRecord>`.
- [x] Track each node scope in `NodeWorkspaceScopes`, keyed by the node scope id (no change to its renew and upgrade logic).
- [x] Emit `node-scope-changed { nodeId }` to the window's renderer on a committed rebind (relay to direct, reopen), instead of reloading a document.
- [x] Release on window close, command-node change, explicit release, and idle. The idle time comes from [4002](4002-hydration-tiers-and-budgets.md); default to never in this item.
- [x] Extract the shared open logic from `window-workspace-target.ts`. Realms keep calling it through the old entry point.

## Tests

- [x] Lazy open is single-flight under concurrent `ensureNodeScope`; renew and upgrade per node scope; release on each trigger; two nodes in one window are independent; two windows on one node get two grants (13.5 A).
- [x] The existing realm tests in `window-workspace-target.test.ts` and `node-workspaces.test.ts` still pass.

## Done when

- [x] Main can open and release node scopes in tests, and nothing in the renderer uses them yet.

## Notes

- API (`apps/desktop/electron/node-scopes.ts`): `DesktopNodeScopes` (one per main process, `nodeScopes` in `main.ts`) with `ensureNodeScope(context, nodeId, { hold? })`, `releaseNodeScope(context, nodeId)`, `dropNodeScopeHold(context, nodeId)`, `releaseWindowNodeScopes(context)`, `sweepIdle()`, `dispose()`; free functions `openWorkspaceScope` (the extracted open), `workspaceTargetFrom` and `onNodeScopeRelease(record, fn)`; `NODE_SCOPE_CHANGED_EVENT`. The methods take the window context, as the report's `ensureNodeScope(context, nodeId)` does; the class only holds the connection manager, the grant tracker and the idle sweep.
- `NodeScopeRecord` has the report's fields plus `lifetime` (below). `ensureNodeScope` also calls `noteUse` on the node scope, so [2007](2007-desktop-node-ipc-and-events.md)'s `getBackend` needs only the ensure. `holds` are renderer holds (`{ hold: true }` adds one, `dropNodeScopeHold` removes one); the idle sweep releases only a scope with no holds, and an explicit release closes the scope regardless.
- Command access: each node scope binds `${scope}:command` to the window's command connection, captured at open. Renewal, reopen and revoke go through it, so they stay with the node that issued the grant even if the window's own scope moves. The plan's "without the portal scope" holds: the window's own scope is never retargeted and no `:portal` scope is made. Scopes per open node: `:node:<id>` (the workspace), `:node:<id>:command`, and transiently `:workspace-open` and `:workspace-retry:<uuid>`.
- Shared open: `openWorkspaceScope` is `applyTarget`'s former body (opening scope, the two closed checks, retarget, `release` + `track`, close-on-failure). `setDesktopWorkspaceTarget` still owns the switch guard, the portal scope, the null target and `committed`; realm behaviour is unchanged except that a failed open now releases the opening scope before the portal (both after the grant is revoked).
- Release triggers: explicit (`releaseNodeScope`), window close (new optional `releaseNodeScopes` hook in `DesktopWindowContexts.register`'s close callback), command-node change (the same hook in `DesktopWindowContexts.useConnection`, and `closeWindowRealms` in `main.ts` for connect, handover and forget), idle (`idleMs`, default null = never; no timer is created unless set; the value comes from [4002](4002-hydration-tiers-and-budgets.md)). A release during an open closes the lifetime; the open then fails at its next closed check and revokes the grant it was given through its opening scope. An ensure right after a release waits for the released open to settle before opening again, because that open still holds the scope names.
- Effect (4.1.2) is used in `node-scopes.ts` only:
  - `NodeScopeRecord.lifetime` is a `Scope.Closeable`. The open is an `Effect.gen` program run with `Scope.provide(lifetime)`: the two `manager.bind` steps are `Effect.acquireRelease` (release = `manager.release`), and the grant's untrack (`NodeWorkspaceScopes.release`, which revokes it) is a `Scope.addFinalizer` registered before the open. Finalizers run in reverse, so the grant is revoked while command access still exists. Any failure closes the lifetime with the failure exit (`Effect.onExit`). A release is `Scope.close(lifetime, Exit.void)`; a step that finishes after it is undone at once, because adding a finalizer to a closed scope runs it. `onNodeScopeRelease` lets [2009](2009-desktop-previews-and-gateway-snapshot.md) register the preview runtime's disposal, which then runs before the grant is revoked. This replaced the hand-ordered try/catch/finally that `applyTarget` needs for the same guarantees.
  - Single flight is a memoised promise (`record.opening`, from `Effect.runPromise`), not a `Deferred` or `Effect.cached`: every caller is plain async, and a promise is the smallest shared handle.
  - Not used: `openWorkspaceScope`, `window-workspace-target.ts` and `NodeWorkspaceScopes` stay plain async. The realm path must keep its exact behaviour and timing until [6003](6003-delete-desktop-realm-code.md), and the tracker's timers and revisions were out of scope ("no change to its renew and upgrade logic").
  - Bundling: `bundleElectron` (Bun.build, ESM, only `electron` external) inlines `effect`; a bundle to a temporary directory succeeded. The subset used (`Effect`, `Exit`, `Scope`, `acquireRelease`, `tryPromise`, `runPromise`, `runFork`) is about 72 KB unminified (32 KB minified) when bundled alone.
- `main.ts` changed only in what wiring needs: the `nodes` field and its two initialisers, the `nodeScopes` instance, the `releaseNodeScopes` hook and one line in `closeWindowRealms`. No IPC exposes node scopes yet ([2007](2007-desktop-node-ipc-and-events.md)).
- The index row in `0000-index.md` is not updated here (it is owned elsewhere for this branch).

## Work log

- 2026-11-07 (claude-worker): added `apps/desktop/electron/node-scopes.ts` (node scopes with Effect `Scope` lifetimes, the shared `openWorkspaceScope`), moved `setDesktopWorkspaceTarget` onto it, added the `releaseNodeScopes` hook to `DesktopWindowContexts`, and wired `nodes` and the release triggers in `main.ts`. Tests: new `apps/desktop/tests/node-scopes.test.ts` (15 pass); with `window-workspace-target`, `node-workspaces`, `desktop-window-contexts` and `connection-manager-federation`, 107 pass. Full desktop suite: 2118 pass, 16 skip, 1 fail (`socket-tos-guard.integration.test.ts`: this worktree's Electron framework binary is truncated, so Electron fails to start; unrelated). Desktop typecheck clean; `oxlint` clean; Electron bundle builds.
