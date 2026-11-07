---
id: 2005
title: "Relay: answer /status and /session for relayed clients"
phase: 2
plan: "§6.2 step 6"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Add `status` to `RELAYED_PATHS`, so the leaf answers with its own credential verdict for the forwarded grant. Confirm that `/status` reveals nothing beyond what the hello already does, and record that in Notes.
- [ ] Decide `/session` (recommended: do not relay it; a relayed client never uses the leaf's cookie session). Make the transport skip session detection for node transports instead.
- [ ] Older command nodes still 404: the transport treats a 404 on `/status` as "probe unavailable", not as a lapse. A compatibility register row is needed only if the client must branch on the version; otherwise say why not.

## Tests

- [ ] Relay test: `/status` is forwarded with the grant and answers the leaf's verdict, and a revoked grant gives 401.
- [ ] Transport test: a 404 from `/status` does not mark the credential lapsed.

## Done when

- [ ] A relayed node transport in a test detects a revoked grant through `/status`.
