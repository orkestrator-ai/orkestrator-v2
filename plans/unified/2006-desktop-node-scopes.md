---
id: 2006
title: "Desktop main: per-(window, node) scopes"
phase: 2
plan: "§6.3 A and §12 Phase 2.3"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
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

- [ ] New `apps/desktop/electron/node-scopes.ts`:
  - `NodeScopeRecord { scope: \`${windowScope}:node:${nodeId}\`, nodeId, target, previewRuntime?, opening, lastUsed, holds }`;
  - `ensureNodeScope(context, nodeId)`: single-flight, reusing `applyTarget`'s open logic without the portal scope;
  - `releaseNodeScope(context, nodeId)`.
- [ ] `DesktopWindowContext.nodes: Map<nodeId, NodeScopeRecord>`.
- [ ] Track each node scope in `NodeWorkspaceScopes`, keyed by the node scope id (no change to its renew and upgrade logic).
- [ ] Emit `node-scope-changed { nodeId }` to the window's renderer on a committed rebind (relay to direct, reopen), instead of reloading a document.
- [ ] Release on window close, command-node change, explicit release, and idle. The idle time comes from [4002](4002-hydration-tiers-and-budgets.md); default to never in this item.
- [ ] Extract the shared open logic from `window-workspace-target.ts`. Realms keep calling it through the old entry point.

## Tests

- [ ] Lazy open is single-flight under concurrent `ensureNodeScope`; renew and upgrade per node scope; release on each trigger; two nodes in one window are independent; two windows on one node get two grants (13.5 A).
- [ ] The existing realm tests in `window-workspace-target.test.ts` and `node-workspaces.test.ts` still pass.

## Done when

- [ ] Main can open and release node scopes in tests, and nothing in the renderer uses them yet.
