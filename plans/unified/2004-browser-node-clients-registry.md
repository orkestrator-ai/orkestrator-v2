---
id: 2004
title: "Browser: per-node client registry with in-memory grants"
phase: 2
plan: "§6.2 steps 4-5 and Connection budget"
status: not-started
depends_on: [2002, 2003]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 2004 · Browser: per-node client registry with in-memory grants

- **Report:** [§6.2](../../docs/reports/unified-federation.md#62-browser-and-ios), [§13.4](../../docs/reports/unified-federation.md#134-browser-path-to-leaves)
- **Decisions:** 13.4 A (direct first, relay fallback), 13.5 A (one grant per window and node)
- **Depends on:** [2002](2002-browser-transport-split.md), [2003](2003-browser-credentials-and-auth-transport.md)
- **Blocks:** [2013](2013-second-scope-proof.md), Phase 4
- **Size:** M
- **Track:** S (scopes), browser lane

## Goal

`apps/web/src/lib/node-scope/node-clients.ts` opens, renews, reopens and revokes a grant per leaf in memory, and hands out a `NodeClient` for it. Nothing changes for realms yet.

## Current state (verified 2026-11-07)

- `lib/portal/workspaces.ts` (157 lines):
  - `reachable` probe (:50-68): GET of the hello with the bearer, `credentials: "omit"`, a 3 s timeout, checking `installationId === nodeId && endpointRole === "client"`;
  - `openLeafWorkspace` (:74-104): tries direct origins, otherwise returns the relay at `${location.origin}${relayBase}` with no token;
  - `keepWorkspaceAlive` (:107-152): 5 s tick, 10 min renew, reconcile on online and focus, `onLapsed` reopens;
  - `closeLeafWorkspace` (:155-157).
- `FrameRealm`'s grant effect is at `RemoteWorkspaceRegion.tsx:540-579`. On lapse it reopens and reloads the frame. The release runs only on effect cleanup. **Nothing sends a close on `pagehide` today.**
- Grants are stored in `sessionStorage` under `orkestrator.workspace-realm:<id>` (`workspace-target-storage.ts`; importers: web-gateway.ts and RemoteWorkspaceRegion).
- `lib/gateway-url.ts` (109 lines) resolves media and preview URLs from the single gateway. It has 12 importers, plus `acp-client.ts`.
- Terminal WebSocket support exists (`terminal-websocket-client.ts`, 1,124 lines; `terminalWebSocketUrl` keeps the relay prefix). The opt-in is the origin-wide key `orkestrator-terminal-transport` (`web-gateway.ts:65`).

## Work

- [ ] `node-clients.ts`: `acquire(nodeId) → NodeClient` (ref-counted) and `release(nodeId)`.
  - Open uses `openLeafWorkspace`'s direct-then-relay probe.
  - Renew uses `keepWorkspaceAlive`.
  - Lapse calls `openLeafWorkspace` again and `transport.setCredential` with no reload.
  - The grant is held only in the closure.
- [ ] Revoke on the last release, and on `pagehide` with a keepalive `close_node_workspace`. The `pagehide` close is new behaviour; record it in Notes.
- [ ] Per-node URLs: `client.baseUrl` and `client.resolveMediaUrl(path)` / `client.resolvePreviewUrl(...)`. `lib/gateway-url.ts` keeps its functions for the command scope and gains node-taking variants.
  - A preview of a direct node goes through the relay unless a grant cookie exists, and none does today (§6.2 step 5). Record the choice.
- [ ] Leaf terminals default to the WebSocket transport (13.4). The per-origin opt-in key is still honoured for the command node.
- [ ] Do not delete `workspace-target-storage.ts` here; realms still use it. It goes in [6002](6002-delete-web-realm-code.md).

## Tests

- [ ] Port `lib/portal/workspaces.test.ts` cases into the registry tests: direct success, direct failure then relay, renewal, lapse then reopen without reload, last release revokes, `pagehide` close.
- [ ] Two leaves acquired at once get independent grants and transports.

## Done when

- [ ] The registry can open two leaves in a test, against fake leaves and against a live attached `dev:test` profile. It is not yet used by the UI.
