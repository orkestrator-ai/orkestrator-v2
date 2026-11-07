---
id: 2010
title: "Route today's invoke and listen through the command scope"
phase: 2
plan: "§6.4 and §12 Phase 2.4"
status: not-started
depends_on: [2001, 2002, 2007]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 2010 · Route today's invoke and listen through the command scope

- **Report:** [§6.4](../../docs/reports/unified-federation.md#64-events-must-carry-their-node), [§12 Phase 2](../../docs/reports/unified-federation.md#12-migration-plan)
- **Depends on:** [2001](2001-node-scope-core.md), [2002](2002-browser-transport-split.md), [2007](2007-desktop-node-ipc-and-events.md)
- **Blocks:** [2011](2011-scope-domain-negotiation.md), [2012](2012-transport-lint-boundary.md), [3001](3001-scoped-store-shim-and-ratchet.md), [3002](3002-lib-backend-client-parameter.md)
- **Size:** M
- **Track:** S (scopes)

## Goal

Every renderer call to a backend goes through a `NodeClient`, at first always the command scope's. Both host families implement `NodeClient`. Behaviour is unchanged.

## Current state (verified 2026-11-07)

- `lib/native/backend.ts` (20 lines) `invoke` checks the prefetched cache, then calls `window.orkestrator.invoke`. It has 31 production importers, 26 of them in `lib/backend/`.
- `lib/native/events.ts` (124 lines): `listen` at :53 has 34 importers; `listenOn(source, …)` is at :62.
- `authoritative-events.ts`: `listenAuthoritative` (:32) and `listenAuthoritativeWith` (:47).
- `lib/prefetched-command-responses.ts`: the `PrefetchedCommandCache` class is already per backend, with a `defaultCache` singleton at :105.
- **52 production files touch `window.orkestrator` directly**, so wrapping `invoke` and `listen` does not cover everything.

## Work

- [ ] Browser `NodeClient` over `createNodeTransport` ([2002](2002-browser-transport-split.md)).
- [ ] Desktop `NodeClient` over preload `node(nodeId)` ([2007](2007-desktop-node-ipc-and-events.md)). The command node uses the existing `window.orkestrator` path.
- [ ] `invoke` and `listen` in `lib/native/*` become command-scope wrappers: `getWindowScope().commandScope().client.invokeRaw/listenRaw`. The prefetched cache becomes per scope (the class instance moves onto the scope).
- [ ] Classify the 52 direct `window.orkestrator` users into transport calls (move them to the scope client), window shell calls (clipboard, window and so on, which stay) and desktop-only APIs. Record the list in a source-guard baseline (`tests/source-guards/`, new guard id `window-orkestrator-direct`) that may only shrink.

## Tests

- [ ] A fake command client receives every invoke the app makes during the existing smoke tests (no direct `window.orkestrator.invoke` calls left in the transport category).
- [ ] The source-guard baseline is committed.

## Done when

- [ ] The app runs entirely through the command scope client on desktop and browser, with `mise run test` and the browser smoke test passing.
