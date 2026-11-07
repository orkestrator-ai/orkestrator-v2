---
id: 2008
title: "Desktop: one request-auth resolver over all node scopes"
phase: 2
plan: "§6.3 D"
status: done
depends_on: [2006]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 2008 · Desktop: one request-auth resolver over all node scopes

- **Report:** [§6.3 D](../../docs/reports/unified-federation.md#63-desktop)
- **Depends on:** [2006](2006-desktop-node-scopes.md)
- **Blocks:** [2013](2013-second-scope-proof.md)
- **Parallel with:** [2007](2007-desktop-node-ipc-and-events.md)
- **Size:** S
- **Track:** S (scopes), desktop lane

## Goal

Media, images and previews that the window renderer loads from any node scope get that node's bearer, chosen by the longest matching path prefix.

## Current state (verified 2026-11-07)

- `connection-manager.ts` (2,189 lines) `getRendererRequestAuthorization` (:1037-1059) handles one scope: the bound remote's origin plus the `<transportBasePath>/__orkestrator/` prefix. Callers:
  - main.ts:361 (the realm installer)
  - main.ts:742 (previews)
  - `window-request-authorization.ts:18`
  - `window-workspace-target.ts:93`
- The main window installs single-scope auth at main.ts:955-983.
- `remote-gateway-request-auth.ts` (220 lines):
  - `installRemoteGatewayRequestAuth` (:175-203);
  - `createRealmRequestAuthInstaller` (:205-220), instantiated at main.ts:359-362 and used at :1149-1150.
  - Its test has 670 lines. `window-request-authorization` has no test.
- Relay node scopes live under `/__orkestrator/nodes/<id>/`, which the command scope's `/__orkestrator/` prefix also matches. So the order of the match matters.

## Work

- [x] `resolveWindowRequestAuthorization(context, url)` over the command scope plus every node scope of the window. It returns the bearer of the longest matching `(origin, pathPrefix)`.
- [x] Install it once per window, replacing the single-scope installer for the main window. Keep `createRealmRequestAuthInstaller` for realm views until [6003](6003-delete-desktop-realm-code.md).
- [x] Add the missing unit test for `window-request-authorization.ts`.

## Tests

- [x] Command scope and a relay node scope on the same origin: the node path gets the node bearer, other paths get the command bearer.
- [x] Two direct nodes on different origins; a removed scope stops matching.

## Done when

- [x] An image served by a leaf through the relay loads in the window renderer with the leaf's grant (desktop test).

## Notes

- API (`apps/desktop/electron/window-request-authorization.ts`): `resolveWindowRequestAuthorization(manager, context, url)` and `createWindowRequestAuthorization(manager, context, localAuthorization) → { authorization, requestOrigin }`, where `context` is `RequestAuthorizationWindow { scope, nodes: ReadonlyMap<nodeId, { scope }> }` and `manager` is `RequestAuthorizationManager` (`getRendererRequestAuthorization`, `getBoundConnectionId`, `getGatewayBaseUrl`). Deviation from the plan's `(context, url)`: the manager is passed explicitly rather than hung on the context (2026-11-07), as the old single-scope function did.
- Matching: each candidate's bearer still comes from `ConnectionManager.getRendererRequestAuthorization(url, scope)` (exact origin, `<base path>/__orkestrator/`, suspended routes refused), so the confinement rules are not duplicated; the resolver only ranks the matches by the length of that prefix, read from `getGatewayBaseUrl(scope)`. On a tie the command scope wins. `connection-manager.ts` is unchanged (options considered: a new "request scope" method on the manager, which would mean editing a file outside this item; recomputing the match in the resolver, which would duplicate the confinement; ranking the manager's own answers, chosen).
- Installed once per window: `main.ts` creates the window's `nodes` map before the window, hands the same map to the authorizer and to the window context, and installs `installRemoteGatewayRequestAuth` once in `beforeLoad` as before. The map is read on every request, so node scopes opened or released later (2007) match, or stop matching, with no reinstall. The Local direct-transport authorization still applies only while the window's own scope is on Local, and only when no scope matched.
- `createRealmRequestAuthInstaller` and its use for realm views are unchanged, until [6003](6003-delete-desktop-realm-code.md). Previews' own `getAuthorization` (main.ts, per preview runtime) is unchanged; per-node preview runtimes are [2009](2009-desktop-previews-and-gateway-snapshot.md).
- "No test" in Current state: `connection-manager.test.ts` did exercise `createWindowRequestAuthorization` (released window, Local transport); its three call sites now pass `{ scope, nodes: new Map() }`. The new `apps/desktop/tests/window-request-authorization.test.ts` is the unit test the item asked for.
- For the orchestrator: on the relay path the node scope's bearer is the command node's token (`openWorkspaceScope` passes the command scope's authorization as the relay token, and `openNodeWorkspace` uses it; the leaf's grant is used only on a direct or loopback route). The resolver still picks the node scope for the leaf's relay paths, so when the relay starts carrying the leaf's grant, or a direct route is used, the right bearer follows. The Done-when test uses distinct tokens for the two scopes to show the choice.
- Done when: the test runs the real `ConnectionManager` (both scopes bound as workspace connections, the node scope under the command origin's relay prefix) and the real `installRemoteGatewayRequestAuth` hook on an image request from the window's main frame; it is not a real Electron renderer, which cannot start in this worktree (truncated Electron binary). Aggregate suite left to review preparation.
- Effect: not used. The resolver is a pure synchronous function called from webRequest hooks, which must answer synchronously and never throw; there is no lifetime or failure to model (a node scope's release already removes it from the map through 2006's Effect `Scope`).

## Work log

- 2026-11-07 (claude-worker): `resolveWindowRequestAuthorization` (longest matching prefix over the command scope and every node scope), `createWindowRequestAuthorization` over the window's scopes, `main.ts` sharing the window's `nodes` map with its authorizer; new `apps/desktop/tests/window-request-authorization.test.ts` (5 tests) and updated callers in `connection-manager.test.ts`. With `remote-gateway-request-auth`, `connection-manager`, `connection-manager-federation`, `node-ipc`, `node-scopes`, `main-ipc`, `preload-api`, `desktop-window-contexts` and `electron-bundle`: 238 pass. `tsconfig.electron.json` clean; `tsconfig.test.json` errors only in `apps/backend` files another agent is editing; `oxlint` clean.
