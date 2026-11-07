---
id: 2008
title: "Desktop: one request-auth resolver over all node scopes"
phase: 2
plan: "§6.3 D"
status: not-started
depends_on: [2006]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] `resolveWindowRequestAuthorization(context, url)` over the command scope plus every node scope of the window. It returns the bearer of the longest matching `(origin, pathPrefix)`.
- [ ] Install it once per window, replacing the single-scope installer for the main window. Keep `createRealmRequestAuthInstaller` for realm views until [6003](6003-delete-desktop-realm-code.md).
- [ ] Add the missing unit test for `window-request-authorization.ts`.

## Tests

- [ ] Command scope and a relay node scope on the same origin: the node path gets the node bearer, other paths get the command bearer.
- [ ] Two direct nodes on different origins; a removed scope stops matching.

## Done when

- [ ] An image served by a leaf through the relay loads in the window renderer with the leaf's grant (desktop test).
