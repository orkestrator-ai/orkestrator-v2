---
id: 2003
title: "Browser: per-node credentials, scoped rich-content clear, no global auth patch"
phase: 2
plan: "§6.2 steps 2-3 and §7.4 special cases"
status: not-started
depends_on: [2002]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 2003 · Browser: per-node credentials, scoped rich-content clear, no global auth patch

- **Report:** [§6.2](../../docs/reports/unified-federation.md#62-browser-and-ios), [§7.4](../../docs/reports/unified-federation.md#74-services-and-module-state)
- **Depends on:** [2002](2002-browser-transport-split.md)
- **Blocks:** [2004](2004-browser-node-clients-registry.md), [3016](3016-rich-content-and-caches.md)
- **Size:** M
- **Track:** S (scopes), browser lane

## Goal

A node transport carries its own bearer, nothing patches globals on its behalf, and a credential change clears only that node's protected content.

## Current state (verified 2026-11-07)

- `gateway-auth-transport.ts` (174 lines), `configureDirectGatewayTransport` (:140-158):
  - replaces `globalThis.fetch`, adding a bearer for the gateway origin under `/__orkestrator/`;
  - replaces `globalThis.EventSource` with `FetchEventSource` (:37-138);
  - holds one module-level `directGatewayAuth`.
  - It is installed only by `installBrowserGatewayApi` (:1650-1652) when both `baseUrl` and `token` are set, which includes realm frames on a direct grant.
  - Tests: `gateway-auth-transport.test.ts` (181 lines); five web-gateway test files import it.
- The raw-fetch audit found `lib/acp-client.ts:49`. It makes a raw `fetch` to the gateway loopback proxy and relies on the patch on a bearer page. The only production `new EventSource(` is in `web-gateway.ts`.
- `applyGatewayToken` (:346-353) calls `clearProtectedRichContent("credentials")` when the token changes. Other calls: `"logout"` (:385) and `"gateway-replaced"` (:1648).
- `lib/chat/rich-content-reset.ts` (161 lines):
  - `clearProtectedRichContent` (:95-100) clears everything;
  - `noteRichContentConnection` (:133-139) and `noteRichBackendIdentity` (:147-152) are module singletons;
  - scheduler keys already carry the backend id at index 2 (:116-118);
  - `ProtectedRichCache` (:38-45) has no per-backend hook.
- **Report correction:** `renew_node_workspace` only extends the expiry (`node-portal.ts:273-290`). A new token comes only with a lapse and reopen, so "hot-swap the token on renewal" applies only to the reopen case.

## Work

- [ ] `NodeTransport.setCredential(token)`: swaps the bearer for later requests and reopens streams with the new one, without a document reload. Use it on lapse and reopen.
- [ ] `clearProtectedRichContent(reason, { nodeId? })`:
  - with a `nodeId`, clear scheduler keys whose index 2 is that node, and call a new `ProtectedRichCache.clearBackend(nodeId)` on every registered cache;
  - without one, clear everything (logout, gateway replaced).
- [ ] Make `noteRichBackendIdentity` and `noteRichContentConnection` per node, so several live nodes do not thrash each other's content (§7.4).
- [ ] Never install `gateway-auth-transport` for a node transport. Keep it only for the hosted single-gateway page, or delete it if that page no longer needs it; record which in Notes.
- [ ] Fix `acp-client.ts` to take its node's transport, or at least its base URL and bearer, explicitly.

## Tests

- [ ] Two transports with different tokens: requests and streams carry their own bearer; `setCredential` affects only one.
- [ ] Rich-content clear by node leaves the other node's entries.
- [ ] `globalThis.fetch` is untouched after creating node transports.

## Done when

- [ ] No node-transport code path depends on the global fetch patch, and the browser smoke test passes.
