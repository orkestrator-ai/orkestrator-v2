---
id: 2004
title: "Browser: per-node client registry with in-memory grants"
phase: 2
plan: "§6.2 steps 4-5 and Connection budget"
status: done
depends_on: [2002, 2003]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] `node-clients.ts`: `acquire(nodeId) → NodeClient` (ref-counted) and `release(nodeId)`.
  - Open uses `openLeafWorkspace`'s direct-then-relay probe.
  - Renew uses `keepWorkspaceAlive`.
  - Lapse calls `openLeafWorkspace` again and `transport.setCredential` with no reload.
  - The grant is held only in the closure.
- [x] Revoke on the last release, and on `pagehide` with a keepalive `close_node_workspace`. The `pagehide` close is new behaviour; record it in Notes.
- [x] Per-node URLs: `client.baseUrl` and `client.resolveMediaUrl(path)` / `client.resolvePreviewUrl(...)`. `lib/gateway-url.ts` keeps its functions for the command scope and gains node-taking variants.
  - A preview of a direct node goes through the relay unless a grant cookie exists, and none does today (§6.2 step 5). Record the choice.
- [x] Leaf terminals default to the WebSocket transport (13.4). The per-origin opt-in key is still honoured for the command node.
- [x] Do not delete `workspace-target-storage.ts` here; realms still use it. It goes in [6002](6002-delete-web-realm-code.md).

## Tests

- [x] Port `lib/portal/workspaces.test.ts` cases into the registry tests: direct success, direct failure then relay, renewal, lapse then reopen without reload, last release revokes, `pagehide` close.
- [x] Two leaves acquired at once get independent grants and transports.

## Done when

- [x] The registry can open two leaves in a test against fake leaves (`node-clients.test.ts`, "two leaves acquired at once", over the real browser `NodeClient` and transport). It is not yet used by the UI.
- [x] The same against a live attached `dev:test` profile: a page opened two leaves at once through the registry (`openLeafScope`) against `uf-2013-cmd` with `uf-2013-leaf` and `uf-2013-smoke` attached, both `live` on their own direct routes (2013's two-leaf case, 2026-11-07).

## Notes

- **API (2026-11-07).** `apps/web/src/lib/node-scope/node-clients.ts`: `createNodeClientRegistry(options?): NodeClientRegistry` with `acquire(nodeId): Promise<LeafNodeClient>`, `release(nodeId)`, `openLeafScope(windowScope, nodeId, { tier? }): Promise<NodeScope>`, `references(nodeId)`, `dispose()`. `LeafNodeClient extends NodeClient` adds `route: ReadableSignal<LeafRoute>` (`WorkspaceConnectionPath` plus `baseUrl`, `relayBaseUrl`), `baseUrl`, `url(path)`, `resolveMediaUrl(path)`, `resolveLoopbackUrl(url)`, `resolvePreviewUrl(url)`. Also `NodeGrantOpenError` (`Data.TaggedError`, carries `nodeId`), `GrantOpenPolicy`/`DEFAULT_GRANT_OPEN_POLICY` (20 s per attempt, 3 retries, 1 s doubling capped at 10 s), `CREDENTIAL_REOPEN_MIN_INTERVAL_MS` (30 s), `LeafTransportClient` (the slice of 2010's `BrowserNodeClient` it uses). Options are all seams with production defaults: `commandInvoke` (`portalInvoke`), `commandNodeName`, `closeOnPageHide`, `lifecycle` (`browserWindowLifecycle()`), `createClient` (2010's `createBrowserNodeClient`), `transport` settings, `probe`, `renewal`, `openPolicy`, `credentialReopenMinIntervalMs`, `clearRichContent`. No app-wide instance yet; [2013](2013-second-scope-proof.md) creates one when it opens a leaf.
- **Additive changes outside `node-clients.ts`.** `lib/portal/workspaces.ts`: `openLeafWorkspace` takes `invoke?`; `LeafWorkspace.relayBaseUrl?` (always set by `openLeafWorkspace`); `keepWorkspaceAlive(id, onLapsed?, { invoke?, tickMs?, renewIntervalMs?, events? })`; `closeLeafWorkspace(id, invoke?)`; exported `CommandNodeInvoke`, `KeepWorkspaceAliveOptions`. Defaults unchanged, so `FrameRealm` behaves as before (its `sessionStorage` copy now also holds `relayBaseUrl`, unused). `lib/gateway-url.ts`: `resolveNodeGatewayUrl(nodeBase, path)`, `resolveNodeLoopbackBaseUrl(nodeBase, url)`, `resolveNodeBrowserPreviewUrl(nodeBase, url)`; `resolveGatewayLoopbackBaseUrl` and `resolveGatewayBrowserPreviewUrl` keep their behaviour and now delegate to them with `getGatewayBaseUrl()`. `node-transport.ts` is untouched.
- **Decision: a lease per `acquire` (2026-11-07).** Options: (a) hand every holder the same client and count `release(nodeId)` calls; (b) a lease per `acquire` whose `dispose()` releases exactly its own reference, with its own listener table. Chosen (b): a `NodeScope` owns and disposes its client (2001), so a lease makes "disposing the scope releases the node" hold without a double release, and a holder's listeners go with it. `release(nodeId)` disposes that node's latest lease (or drops a reference still opening), so the item's API holds too.
- **Decision: lapse with a route change (2026-11-07).** The reopened grant is probed again, so it can come back on another route (the leaf's origin stopped answering: relay; or another origin). Same base: `setCredential` on the same transport (direct; a relayed route carries no bearer, so nothing changes and the transport retries on its own). Another base: a new transport client replaces the old one inside a stable per-node client, which re-attaches its listeners (`createListenerFanout` suspend/resume) and mirrors the new connection signal; the holders keep the same object. Both are without a document reload. A pending `eventStreamReady` on the replaced transport rejects (it was disposed). Order on reopen: clear `{ nodeId }` rich content (only when the credential or route changed), hand the transport the new bearer, then revoke the old grant, so the streams never see their own credential revoked.
- **Lapse triggers.** A failed renewal (`keepWorkspaceAlive`'s `onLapsed`, as `FrameRealm`), a credential refusal from the leaf transport (`onCredentialRejected`, new), and a page restored from the back/forward cache (its grants were revoked on `pagehide`). Refusal-triggered reopens are at least `CREDENTIAL_REOPEN_MIN_INTERVAL_MS` apart, so a leaf (or a lapsed page session on the relay) that refuses every new grant is not asked in a loop; a reopen that fails leaves the client `lapsed`, and the renewal's tick, `online` and `focus` retry.
- **New behaviour: `pagehide` revokes (2026-11-07).** On `pagehide` every grant is closed with a keepalive `POST /__orkestrator/invoke` `close_node_workspace` to the page's command gateway (`resolveGatewayApiUrl`, `credentials: "same-origin"`), which outlives the page; renewal stops. On `pageshow` after that (back/forward cache) every held node opens a new grant and swaps it in. Before, nothing closed a grant on `pagehide` (`FrameRealm` closed only on effect cleanup, which a closing tab never runs), so grants lived out their 15 minutes. Limit: a hosted page whose command gateway needs a bearer (web-public) sends this close without one and gets 401; its grants then expire on their TTL as today. Such a page can pass `closeOnPageHide`.
- **Decision: element loads go through the relay (§6.2 step 5).** `resolveMediaUrl`, `resolveLoopbackUrl` and `resolvePreviewUrl` always use the leaf's relay base, even for a direct leaf: an `<img>`, link, download or preview frame cannot carry the grant's bearer, and no grant cookie exists. `url(path)` uses the route in use, for `fetch`es that carry the bearer. The preview has the same limits as the command node's own preview (`isGatewayBrowserPreviewSupported`).
- **Leaf terminals use WebSocket.** Every leaf transport gets `terminalTransport: "websocket"` (failures still fall back to HTTP/SSE inside the transport). The origin-wide `orkestrator-terminal-transport` key is read only by `createBrowserGatewayApi`, i.e. for the command node, unchanged.
- **Where Effect is used (2026-11-07).** (1) Grant lifetimes: a registry root `Lifetime` (Effect `Scope`), one child per node, one grandchild per grant; the grant's finalizers stop its renewal and revoke it, so replacement, last release, `pagehide` and `dispose()` all end a grant the same way, in a defined order. (2) Opening a grant is an `Effect.tryPromise` with `Effect.timeout` per attempt and `Effect.retry` on `Schedule.exponential` capped with `Schedule.modifyDelay` and bounded by `Schedule.upTo({ times })`; it runs with the node's `AbortSignal`, so a release interrupts it, and an attempt interrupted by its timeout or a release revokes the grant if it arrives late. (3) `NodeGrantOpenError` is a `Data.TaggedError`. Not used: the renewal stays `keepWorkspaceAlive` (the item says so, and `FrameRealm` still uses it), and the leases and listener fanout are plain synchronous code React reads.
- **Coordination with 2010.** 2010's `createBrowserNodeClient` (committed in `ceee0b9d4`) is the default `createClient`; no adapter was needed.
- **Done when, live profile (closed 2026-11-07 by [2013](2013-second-scope-proof.md)'s two-leaf case; the note below is the earlier state).** Opening two leaves against a live attached `dev:test` profile needs a command node with two linked leaves running on isolated profiles, which this worker cannot start safely (the production instance shares the host). The fake-leaf proof is ticked; the live run is left to the final live qualification pass, or to [2013](2013-second-scope-proof.md), which opens a leaf scope in the app. The aggregate suite is left to review preparation.

## Work log

- 2026-11-07 (claude-worker): added `apps/web/src/lib/node-scope/node-clients.ts` (registry, leases, grant lifetimes, Effect open policy, `pagehide` keepalive revoke, reopen without reload, per-node URLs, WebSocket leaf terminals) and `node-clients.test.ts` (19 tests: direct, direct failure then relay, HTML/wrong installation, retries, timeout with late grant revoked, renewal, lapse then reopen without reload, refusal reopen and its interval, reopen on another route, last release revokes, released while opening, `pagehide` close and restore, default keepalive close, dispose, per-node URLs, node URL variants, two leaves over the real transport, leaf scope in a `WindowScope`); made `lib/portal/workspaces.ts` injectable and added the node-taking variants to `lib/gateway-url.ts`. Tests: `node-clients.test.ts` 19 pass (380 pass over 20 reruns); `lib/node-scope`, `lib/portal`, `lib/native`, `components/federation`, `gateway-url`, `browser-address`, `environment-address`: 883 pass across 58 files. Web typecheck: no errors in these files (7 in another agent's `rich-content-reset.test.tsx`). fmt and oxlint clean; no source-guard findings in these files. Open: the live `dev:test` run.
- 2026-11-07 (claude-worker, 2013 live pass): opened two leaves at once against a live attached `dev:test` setup at commit `6860254e8` (spec in `6d985b088`): `e2e/agent-testing/scope-proof.spec.ts` "one page holds the command scope and two leaf scopes at once (direct)" with `ORKESTRATOR_AGENT_TEST_PROFILE=uf-2013-cmd`, `ORKESTRATOR_AGENT_TEST_LEAF_PROFILE=uf-2013-leaf`, `ORKESTRATOR_AGENT_TEST_SECOND_LEAF_PROFILE=uf-2013-smoke`: 1 passed. Three scopes live at once (command + two leaves), each leaf read, listened to and given a terminal over its own grant and direct route; the relay path was proven for one leaf by 2013's relay case (also passed). Live Done-when ticked; status done (aggregate suite left to review preparation, as in Notes).
