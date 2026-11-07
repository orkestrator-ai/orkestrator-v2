---
id: 2003
title: "Browser: per-node credentials, scoped rich-content clear, no global auth patch"
phase: 2
plan: "§6.2 steps 2-3 and §7.4 special cases"
status: in-progress
depends_on: [2002]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] `NodeTransport.setCredential(token)`: swaps the bearer for later requests and reopens streams with the new one, without a document reload.
- [x] Use it on lapse and reopen. Today a lapse reopens the realm frame (`FrameRealm`, `RemoteWorkspaceRegion.tsx`), which reloads its document; the per-node registry that lifts grant open/renew/lapse out of it, and so the caller of `setCredential` on reopen, is [2004](2004-browser-node-clients-registry.md). Done in 2004: `node-clients.ts` reopens on a failed renewal, a refused credential or a restored page, clears `{ nodeId }` and calls `setCredential` (no reload).
- [x] `clearProtectedRichContent(reason, { nodeId? })`:
  - with a `nodeId`, clear scheduler keys whose index 2 is that node, and call a new `ProtectedRichCache.clearBackend(nodeId)` on every registered cache;
  - without one, clear everything (logout, gateway replaced).
- [x] Make `noteRichBackendIdentity` and `noteRichContentConnection` per node, so several live nodes do not thrash each other's content (§7.4).
- [x] Never install `gateway-auth-transport` for a node transport. Keep it only for the hosted single-gateway page, or delete it if that page no longer needs it; record which in Notes. **Deleted** (Notes).
- [x] Fix `acp-client.ts` to take its node's transport, or at least its base URL and bearer, explicitly.

## Tests

- [x] Two transports with different tokens: requests and streams carry their own bearer; `setCredential` affects only one.
- [x] Rich-content clear by node leaves the other node's entries.
- [x] `globalThis.fetch` is untouched after creating node transports.

## Done when

- [x] No node-transport code path depends on the global fetch patch (the patch is deleted).
- [ ] The browser smoke test passes. Left to the final live qualification pass.

## Notes

- **API (2026-11-07).**
  - `NodeTransport.setCredential(token)` (`apps/web/src/lib/native/node-transport.ts`): the same credential again is a no-op; otherwise the bearer is swapped and every open or waiting stream is reopened now with the new one: the main stream (fetch or `EventSource`, resuming from its cursor), the shared terminal stream (its terminals reconcile their snapshot, as after any reopen), the relayed stream (new `RelayedEventStream.reopen()` in `packages/protocol/src/relayed-event-stream.ts`, resuming from its cursor) and the terminal WebSocket (`updateToken`, as before). A swap is not a failure: the ladders count none (`disconnected()`), and a main stream that was refused starts a fresh ladder (`reset()`) and stops counting as refused, so a lapse followed by a new grant reconnects at once instead of after the backoff. Option and return shapes are unchanged.
  - `clearProtectedRichContent(reason, { nodeId? })` (`apps/web/src/lib/chat/rich-content-reset.ts`): with a `nodeId`, drops scheduler keys whose index 2 is that node, view-state keys under `richBackendPrefixes(nodeId)` (new in `rich-identity.ts`), and calls `ProtectedRichCache.clearBackend(nodeId, reason)` on every cache, falling back to `clearAll(reason)` for a cache without one (over-clears, never leaks); counted as `richContentResetCounters.node`. Without one, everything, as before.
  - `clearBackend` implemented by `artifact-requests` (`clearArtifactRequestsForBackend`), `artifact-publications` (`clearArtifactPublicationsForBackend`), `artifact-live-host` and `transcript-artifact-capabilities` (forgets its snapshot only if it came from that node). `media`, `markdown-search` and the per-find `agent-chat-find` caches hold no backend in their keys yet and are cleared whole by a node clear; keying them by node is [3016](3016-rich-content-and-caches.md).
  - `noteRichContentConnection(id, { nodeId? })` and `noteRichBackendIdentity(id, { nodeId? })` track one value per node, with a separate window slot for callers that name no node. Window slot: a change clears everything (today's behaviour, and today's two callers, `App.tsx` and `useTranscriptArtifactCapabilities.ts`, are unchanged). Named node: a connection change clears that node; an identity change clears the content keyed by the identity it replaced (content is keyed by the scope's `backendId`, which is the identity), so another live node's content survives. Moving the callers onto node scopes is [3016](3016-rich-content-and-caches.md).
  - `createAcpClient(bridgeUrl, authToken, transport?)` (`apps/web/src/lib/acp-client.ts`): `transport` is `AcpNodeTransport = Pick<NodeTransport, "url" | "requestHeaders" | "requestCredentials">`. With one, a loopback bridge goes through that node's `/__orkestrator/proxy/loopback/<port>` with that transport's bearer (read per request, so `setCredential` reaches it) and credentials mode; without one, or for a non-loopback bridge, the bridge is called directly. It no longer reads `window.orkestratorGateway` (`resolveGatewayLoopbackBaseUrl`) nor relies on the fetch patch. `acpLoopbackProxyPath` is exported. `createAcpClient` has no production caller today (only its tests), so nothing else changed.
- **Decision: `gateway-auth-transport` deleted (2026-11-07).** Options: (a) keep it, installed only for the hosted single-gateway page (`apps/web-public` `PublicApp`, which calls `installBrowserGatewayApi` with a base and token), not for realm frames; (b) delete it. The audit of raw `fetch`/`EventSource` users in `apps/web/src` and `apps/web-public/src` found: the transport and the window shell (send their own bearer); `lib/portal/workspaces.ts` (sends its own bearer); `web-public/src/connection.ts` (sends its own, before install); `MediaGallery.tsx` `copyImage` (fetches a `data:` or media `src`, and in a browser `clipboard.writeImage` answers first); and `acp-client.ts`, the one that relied on the patch, fixed above. The only `new EventSource(` is in `node-transport.ts`, used only without a bearer. So the hosted page no longer needs it either. Pros of deleting: no page-wide patch of `fetch` and `EventSource` keyed to one origin and token, which could never serve two nodes; a credential swap has one path. Con: an unseen raw caller on a bearer page would now go without a bearer and get a 401 (visible, not a leak). Chosen: (b). Deleted `gateway-auth-transport.ts` and its test; `installBrowserGatewayApi` and the shell's `applyGatewayToken` no longer call it; the five `web-gateway*` suites and `web-public/src/PublicApp.test.tsx` lose their `clearDirectGatewayTransport` cleanup (the latter is outside this item's file set, a one-line removal); the `web-gateway.test.ts` test of the patch itself is replaced by one asserting that installing a direct client patches neither global. For [6002](6002-delete-web-realm-code.md): there is no `gateway-auth-transport.test.ts` left to replace.
- **The window's own token change stays a window-wide clear (2026-11-07).** `applyGatewayToken` (window shell) still calls `clearProtectedRichContent("credentials")` without a node: the window's command transport has no node id at construction (a hosted page learns it from the capabilities read), and everything the window shows came through that connection, relayed leaves included. A node transport's owner (the [2004](2004-browser-node-clients-registry.md) registry) clears `{ nodeId }` when it calls `setCredential`.
- **Small behaviour changes (2026-11-07).** (1) `setCredential` with the same token no longer closes the terminal WebSocket; before, every call did. (2) A main fetch stream aborted while its request was in flight no longer reports `connected` if the response lands after the abort (only reachable through a replacement or `closeMainStream` racing the response). (3) `createAcpClient` without a transport no longer rewrites a loopback bridge through the page's gateway; no production caller.
- **Outside the file set.** `packages/protocol/src/relayed-event-stream.ts` (additive `reopen()`), `apps/web-public/src/PublicApp.test.tsx` (removed the deleted module's cleanup).
- **Effect: not used (2026-11-07).** The credential swap is a synchronous state change inside the callback-driven stream code that 2002 kept as moved code, and the rich-content clear is a synchronous walk of registered caches called from React and store code; neither has an Effect consumer, and wrapping them would add a runtime boundary with nothing on the other side. Revisit with the 2004 registry, whose grant open/renew/lapse lifecycle is a natural Effect `Scope` with `Schedule`d renewal.
- **Done when.** The browser smoke test (`test:agent:browser` against an isolated profile) was not run: it drives a live real-stack profile and AGENTS.md keeps it out of default validation. Left to the final live qualification pass; the aggregate suite is left to review preparation.
- **For the report.** §6.2 step 3 can say the module was deleted (no node or hosted page needs it); Appendix B's `gateway-auth-transport.ts` row and Appendix D's `gateway-auth-transport.test.ts` entry are already gone.
- **Status (2026-11-07, with 2004).** Every Work and Tests box is ticked; only the Done-when browser smoke test remains (left to the final live qualification pass), so the item stays `in-progress`.

## Work log

- 2026-11-07 (claude-worker): `setCredential` reopens the transport's main, shared terminal and relayed streams (new `RelayedEventStream.reopen()`) and the terminal WebSocket with the new bearer, no-op for the same one; `clearProtectedRichContent(reason, { nodeId })` with `ProtectedRichCache.clearBackend` (artifact requests, publications, live host, capabilities) and `richBackendPrefixes`; per-node `noteRichContentConnection` / `noteRichBackendIdentity`; deleted `gateway-auth-transport` and its uses; `createAcpClient` takes its node's transport. Tests: new `node-transport.test.ts` cases (two transports with different tokens, `setCredential` reopening only one; a new credential after a refusal reconnects at once; globals untouched), three rich-content per-node cases, two ACP cases, and the install test now asserting no global patch. `lib/native`, rich-content reset and ACP suites: 434 pass across 22 files; with `lib/chat`, `lib/portal`, `lib/node-scope`, `lib/federation`, `stores`, `components/chat`, `components/federation`, `App.test.tsx`: 4,088 pass, 1 fail across 252 files, the failure (`MessageMarkdown.preview-links.test.tsx`, `api.listen is not a function` in `lib/node-scope/command-client.ts`) in another agent's in-progress node-scope files; `web-public` suite passes. Typecheck clean for `apps/web`, `apps/web-public`, `packages/protocol`; fmt and oxlint clean. Open: "use it on lapse and reopen" (2004) and the browser smoke test.
- 2026-11-07 (claude-worker, with 2004): "use it on lapse and reopen" done by the browser node-client registry (`apps/web/src/lib/node-scope/node-clients.ts`): a lapse, refusal or back/forward-cache restore opens a new grant, calls `clearProtectedRichContent("credentials", { nodeId })`, then `setCredential` on the same transport; covered by `node-clients.test.ts`. Only the browser smoke test remains open.
- 2026-11-07 (claude-worker, 2013 live pass): ran the browser smoke suite (`mise run test:agent:browser`) against a running `dev:test` profile `uf-2013-smoke` (started like the isolated runner: `--fixture --no-agent-credentials --agent-platforms codex`) at commit `6860254e8`: 51 passed, 3 failed, 124 skipped. The failures are all `e2e/agent-testing/terminal-input-resume.spec.ts`: one fails at base `148e9ad0a` on this host too (vim ruler), two are spec drift after 3008 made `terminalPortalStore.getTerminal` take a `nodeId` (the spec still calls `getTerminal(environmentId, tabId)`). The smoke run did not pass, so the smoke box stays open; it can be ticked after `terminal-input-resume.spec.ts` is updated for 3008 and a smoke run passes (the vim case excepted or fixed). Details and result files: [2013](2013-second-scope-proof.md) Notes, `output/agent-testing/uf-2013/`.
- 2026-11-07 (claude-worker, 4006): browser smoke `mise run test:agent:browser` at `4ece07c9a` against `uf-4006-smoke` (started as the isolated runner starts its own, flags and environment): 52 passed, 2 failed, 124 skipped. Failures: `terminal-input-resume.spec.ts` "a lost terminal write stays fenced …" (the vim status-line pattern that fails at base `148e9ad0a` on this host: pre-existing, environmental) and `browser-gateway.spec.ts` "capped file tree … across inactive views and reload" (390 px after a reload the projects drawer stays open after selecting the environment; passed at `6860254e8`, so a branch regression since; details in [4006](4006-multi-node-qualification.md) Notes). The smoke box stays open.
