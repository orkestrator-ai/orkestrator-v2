---
id: 2005
title: "Relay: answer /status and /session for relayed clients"
phase: 2
plan: "§6.2 step 6"
status: done
depends_on: []
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 2005 · Relay: answer /status and /session for relayed clients

- **Report:** [§6.2 step 6](../../docs/reports/unified-federation.md#62-browser-and-ios)
- **Depends on:** none
- **Parallel with:** everything in Phase 2
- **Size:** S
- **Track:** S (scopes), backend

## Goal

A node transport on a relay base URL can run its credential probe and session detection, and gets a meaningful answer instead of a 404.

## Current state (verified 2026-11-07)

- `apps/backend/src/core/nodes/node-relay.ts` `RELAYED_PATHS` (:27-34) covers hello, invoke, events, terminal, `proxy/loopback/<port>` and `browser/loopback/<port>`. It does not cover `/status` or `/session`.
  - `parseRelayPath` returns null (:76-88).
  - `gateway-auth.ts:429-437` answers 404.
- `checkMainStreamCredential` (`web-gateway.ts:418-435`) probes `/status`, so a 401 diagnosis on the relay path never works. `detectBrowserSession` (`/session`) only runs for same-origin cookie clients, and a 404 turns it off.

## Work

- [x] Add `status` to `RELAYED_PATHS`, so the leaf answers with its own credential verdict for the forwarded grant. Confirm that `/status` reveals nothing beyond what the hello already does, and record that in Notes.
- [x] Decide `/session` (recommended: do not relay it; a relayed client never uses the leaf's cookie session). Make the transport skip session detection for node transports instead.
- [x] Older command nodes still 404: the transport treats a 404 on `/status` as "probe unavailable", not as a lapse. A compatibility register row is needed only if the client must branch on the version; otherwise say why not.

## Tests

- [x] Relay test: `/status` is forwarded with the grant and answers the leaf's verdict, and a revoked grant gives 401.
- [x] Transport test: a 404 from `/status` does not mark the credential lapsed.

## Done when

- [x] A relayed node transport in a test detects a revoked grant through `/status`.

## Notes

- `/status` reveals nothing beyond the hello. The leaf answers an authenticated GET with `200 { ok: true }` and nothing else (405 for other methods); the hello carries the installation id, generation, version, profile and capabilities. Both sit behind the same authentication and are both in `GRANT_ALLOWED_PATHS`, so a relayed `/status` tells a client strictly less than the relayed hello it can already read. The relay drops the leaf's `set-cookie`, as for every relayed path.
- What the verdict is about: the relay drops the client's credential and sends the command node's own link credential to the leaf (`NodeLink.transport()`). A relayed 401 therefore comes either from the command node (the client's own credential or cookie session lapsed, refused before anything is relayed) or from the leaf (the forwarded credential was revoked). Both mean "credential refused, no retry helps", which is all the transport needs; it does not tell them apart.
- `/session` is not relayed (`gateway-auth.ts` keeps answering 404 for it). A relayed client never holds the leaf's cookie session. `detectsBrowserSession` (`web-gateway.ts`) now skips session detection for a transport whose base is a relay base (`/__orkestrator/nodes/<id>`); a grant transport already skipped it by sending a bearer. Before this, a relayed realm frame (same-origin, no token) asked the relay for `/session`, got 404 and turned detection off, so the observable change is one fewer request.
- 404 on `/status`: `credentialProbeVerdict` makes the existing behaviour explicit and tested. Only 401 is "refused"; 404 (an older command node whose relay predates `/status`), 403, 429 and 5xx are "unavailable" and leave the stream an ordinary outage on its backoff ladder.
- No compatibility register row. The client does not branch on the peer's version or capability: it never sent a request that only newer peers accept, and every non-401 answer already meant "no verdict" before this item. Against an older command node the relayed probe simply gives no verdict, exactly as today; there is no compatibility code with a removal condition and no counter to watch. This follows the rule that a 404 from a newer route means the peer predates it, never that a credential is gone.
- Finding: in the current web code a node transport never runs the `/status` probe. `checkMainStreamCredential` runs only for the `EventSource` main stream, which is used only without a `baseUrl` and bearer (the page's own same-origin gateway). Every node transport has a `baseUrl` (direct or relay), so it reads its main stream with `fetch` and sees the 401 on the stream response itself; the 401 diagnosis on the relay path already worked that way. Relaying `/status` matters for any client that probes it separately (a split transport from 2002 that keeps an `EventSource`, iOS, tooling), and is harmless otherwise.
- Done when is left open for that reason: no test has a web node transport detect a revoked grant *through `/status`*, because none probes it. What is proven instead: the backend test drives the relayed `/status` probe and gets 401 once the forwarded grant is revoked (and 401 for a bad client credential), and the web test shows a relayed transport (relay base, same origin, no token) treating a relayed 401 as a refused credential, not an outage, without ever asking for `/session`. If that pair is accepted as meeting the intent, tick it and set `status: done`.
- Update 2026-11-07 (with [2002](2002-browser-transport-split.md)): `createNodeTransport` now probes `/status` when its main fetch stream fails without a 401 (an HTTP error or a stream that ended), and takes a `refused` verdict as a refused credential rather than an outage; `installBrowserGatewayApi` enables it for a page on a base URL (workspace realms, direct or relayed). `node-transport.test.ts` ("a relayed node transport whose grant is revoked") drives a relayed transport on a same-origin relay base whose stream ends, or whose retry answers 502, while the relayed `/status` answers 401: it reports the refusal once and stays `connecting`, never `disconnected`; a 200 or 404 from `/status` leaves it an outage. That meets Done when, which is now ticked. `detectsBrowserSession` moved to `window-shell.ts` (re-exported from `web-gateway.ts`); `credentialProbeVerdict` to `node-transport.ts`.
- Effect: not used. This is one routing regex plus two small pure functions on an existing imperative transport; nothing to compose.

## Work log

- 2026-11-07 (claude-worker): added `status` to `RELAYED_PATHS` with a doc note on `/status` and `/session` (`apps/backend/src/core/nodes/node-relay.ts`); added `credentialProbeVerdict` and `detectsBrowserSession` to `apps/web/src/lib/native/web-gateway.ts` and used them in the credential probe and session detection (no restructuring). Tests: new DP-03 case in `apps/backend/tests/gateway-command-nodes.test.ts` (relayed `/status` 200 `{ ok: true }`, relayed `/session` 404, revoked grant 401, bad client credential 401); new describe in `apps/web/src/lib/native/web-gateway-reconnect.test.ts` (verdict table, session-detection rule, 404 from `/status` is not a lapse, relayed transport refused without `/session`). Backend relay suites 43 pass; web gateway suites 201 pass; backend and web typecheck clean.
- 2026-11-07 (claude-worker, with 2002): Done when met: node transports probe `/status` after a non-401 main-stream failure, and `apps/web/src/lib/native/node-transport.test.ts` shows a relayed transport detecting a revoked grant through `/status` (5 cases). Status set to done.
