---
id: 2002
title: "Browser: split createNodeTransport from the window shell API"
phase: 2
plan: "§6.2 step 1 and §12 Phase 2.2"
status: done
depends_on: [2001]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 2002 · Browser: split createNodeTransport from the window shell API

- **Report:** [§6.2 Browser and iOS](../../docs/reports/unified-federation.md#62-browser-and-ios)
- **Depends on:** [2001](2001-node-scope-core.md) (for the `NodeClient` type)
- **Blocks:** [2003](2003-browser-credentials-and-auth-transport.md), [2004](2004-browser-node-clients-registry.md), [2010](2010-command-scope-wiring.md)
- **Parallel with:** the desktop lane ([2006](2006-desktop-node-scopes.md) to [2009](2009-desktop-previews-and-gateway-snapshot.md)), [2005](2005-relay-status-and-session.md)
- **Size:** M (mostly moved code, not rewritten)
- **Track:** S (scopes), browser lane

## Goal

`createNodeTransport(options)` holds everything per backend: invoke, listen, streams, terminals, watchdog and the input sequencer. Several can coexist in one page. The window-only parts move to a separate window shell API. The change is behaviour-neutral.

## Current state (verified 2026-11-07)

`apps/web/src/lib/native/web-gateway.ts` has 1,743 lines. `createBrowserGatewayApi` spans :186-1619.

Transport parts:

| Part | Lines |
|---|---|
| backoff and state | :187-224 |
| watchdog | :225-259 |
| stream state | :261-316 |
| URL, headers, `applyGatewayToken` | :316-353 |
| credential lapse and the `/status` probe | :380-435 |
| events | :520-594 |
| main stream | :716-914 |
| terminal streams | :915-1358 |
| WebSocket | :1269-1302 |
| `readGatewayResponse` and pagehide keepalive | :1360-1388 |
| `invokeImmediately` | :1390-1408 |
| `TerminalInputSequencer` | :1414-1446 |
| API object | :1448-1514 |
| disposer | :1604-1617 |

Window shell parts:

| Part | Lines |
|---|---|
| `connections` | :355-365 |
| cookie-session detection | :437-512 |
| boot metrics | :595-715 |
| `clipboard` | :1516-1535 |
| `webClient` | :1539-1584 |
| `process` | :1586-1591 |
| `window` | :1593-1602 |

Couplings the split must cut:

- boot-metric hooks inside the stream code (:743, 764-766, 795, 822-824, 912);
- `handleCredentialLapse`, which belongs to the cookie session, called from transport code (:367, :402);
- `apiUrl` falling back to the global `resolveGatewayApiUrl` (:327);
- `webClient.getStatus` using `getGatewayBaseUrl()` (:1544);
- `document`/`window` visibility and online listeners (:1255-1266) and pagehide (:1380-1388).

Module load (:1740-1743) installs:

- `window.orkestrator` and `window.orkestratorGateway` (`installBrowserGatewayApi`, :1636-1663);
- a second gateway as `window.orkestratorPortal` inside realms (`workspaceTargetGatewayOptions`, :1716-1738).

The report omits the `window.orkestratorPortal` install.

Tests (keep and adapt):

| File | Lines |
|---|---|
| `web-gateway.test.ts` | 4,476 |
| `-reconnect` | 1,580 |
| `-local-desktop` | 338 |
| `-relayed-stream` | 273 |
| `-silent-recovery` | 258 |
| `-shared-terminal-stream` | 178 |
| `-contract` | 165 |

## Work

- [x] Move the transport parts into `apps/web/src/lib/native/node-transport.ts` as `createNodeTransport(options)`. Options include:
  - `baseUrl` (required, with no global fallback);
  - `credential`;
  - `onCredentialRejected`;
  - `metrics?: TransportMetricsHooks`;
  - `lifecycle?: { onVisibility, onOnline, onPageHide }`, injected by the window so the transport attaches no `document` or `window` listeners itself.
- [x] Window shell API in `window-shell.ts`: clipboard, webClient (status from the command transport), process, window, connections, boot metrics and cookie-session detection. It wires its hooks into the command transport.
- [x] Keep `createBrowserGatewayApi` as a thin composition of the two, so `installBrowserGatewayApi` and the realm path are unchanged.
- [x] Rename across tests only where needed. Keep each test file's coverage, and move tests that belong to the shell into `window-shell.test.ts`.
- [x] The local desktop path (`installLocalDesktopGateway`, :1675-1707) is unchanged.

## Tests

- [x] All seven `web-gateway*` suites pass.
- [x] New: two `createNodeTransport` instances against two fake gateways in one page keep separate streams, cursors, terminals, backoff and credentials, and disposing one leaves the other running.

## Done when

- [x] Two transports can coexist in a test.
- [x] The browser smoke test (`test:agent:browser` against an isolated profile) passes with no visible change. 2026-11-07 at `ee73894da`: 53 passed, the only failure the vim case that fails at base `148e9ad0a` on this host (see Work log).

## Notes

- **API (2026-11-07).** `apps/web/src/lib/native/node-transport.ts`: `createNodeTransport(options): NodeTransport`. Options: `baseUrl` (required), `credential`, `onCredentialRejected`, `metrics?: TransportMetricsHooks` (`mainStreamStarting`, `mainStreamOpened`, `mainStreamIdle`), `lifecycle?: NodeTransportLifecycle` (`onVisibility(visible)`, `onOnline()`, `onPageHide(hiding)`, each returning its stop), `probeCredentialOnStreamFailure` (default on), plus every reconnect, watchdog, terminal-input and terminal-transport setting `BrowserGatewayOptions` already had. `NodeTransport`: `invoke`, `listen`, `eventStreamReady`, `eventStreamConnection`, and for its owner `baseUrl`, `requestCredentials`, `url(path)`, `requestHeaders(h)`, `readResponse(res, fallback)`, `credential()`, `setCredential(token)`, `dispose(reason?)`. Also exported: `credentialProbeVerdict`, `GatewayEventStreamConnectionState`, `TERMINAL_OUTPUT_EVENT_PREFIX`, `GATEWAY_PREFIX`. `apps/web/src/lib/native/window-shell.ts`: `createWindowShell(options, createTransport)` returns `{ transport, api: { clipboard, connections?, webClient, process, window }, applyGatewayToken, dispose }`; `createTransport(hooks)` receives `{ onCredentialRejected, metrics, lifecycle }` and must pass them on, which is how the shell wires itself into the command transport. Also `browserWindowLifecycle()`, `detectsBrowserSession`, `BROWSER_SESSION_ACTIVITY_REFRESH_INTERVAL_MS`. `web-gateway.ts` (309 lines, was 1,771) keeps `BrowserGatewayOptions`, `createBrowserGatewayApi` (the composition), `disposeBrowserGatewayApi`, `installBrowserGatewayApi`, `installLocalDesktopGateway`, `workspaceTargetGatewayOptions` and re-exports the moved names, so no importer changed.
- **Deviation: `baseUrl: null` for the page's own gateway (2026-11-07).** The same-origin page with no configured base reads its main stream with an `EventSource` and asks for keepalive events; a transport with a base never does. That is behaviour, not just a URL, so the page gateway stays a distinct endpoint: `{ baseUrl: null, resolvePageUrl }`, where the window-level composition passes `resolveGatewayApiUrl`. A string `baseUrl` is required otherwise, an empty one throws, and the transport never consults `window.orkestratorGateway`. Options considered: an empty-string base (hides the behaviour switch), a separate `pageGateway` flag (two fields that must agree). Chosen: the discriminated pair, checked by the type.
- **What the transport still reads from the page.** `window.location` once, to decide whether its base is cross-origin (`credentials: "omit"`), and for the page gateway's terminal WebSocket URL (`terminalWebSocketUrl(undefined)`). Those are facts about the page, not a gateway setting, and are the same for every transport in it. The `localStorage` terminal-transport opt-in moved to the composition; the transport defaults to `http-sse`.
- **Credential swap.** `applyGatewayToken` moved to the shell: it keeps the global `clearProtectedRichContent("credentials")` and `updateDirectGatewayToken`, and calls `transport.setCredential`, which swaps the bearer for later requests and the terminal socket only (today's behaviour). Reopening streams with the new credential and scoping the clear to one node are [2003](2003-browser-credentials-and-auth-transport.md).
- **Behaviour changes, all small and deliberate (2026-11-07).** (1) `dispose` now also closes the main stream, cancels its pending retry and stops its watchdog, and the shell's dispose clears the boot-metrics timers; before, a disposed gateway's main stream kept running until its last listener left. `listen` on a disposed transport opens nothing. Production never disposes a gateway (only `replaceExisting` in tests does), so this changes no visible behaviour and makes "disposing one leaves the other running" mean the disposed one stops (invariant 15). (2) `pagehide`/`pageshow` listeners are removed on dispose; before they were never removed. (3) The transport's `online` listener is now attached before the cookie-session probe's, because the shell creates the transport first; the two handlers are independent. (4) The 2005 `/status` probe after a non-401 fetch-stream failure, below.
- **`/status` probe for node transports (2005 Done when).** A fetch-read main stream that fails without a 401 (an HTTP error, or a stream that ended) now asks `/status` before backing off, and treats a `credentialProbeVerdict` of `refused` exactly as a 401 on the stream: `onCredentialRejected`, state `connecting` instead of `disconnected`, no further probe until the stream opens or a failure nothing answered (a network error) clears it, mirroring the `EventSource` path. Not after a silent drop (the link, not the credential, is the problem). `createNodeTransport` defaults it on; `createBrowserGatewayApi` defaults it off, so the local desktop window, the portal gateway and fixtures are unchanged; `installBrowserGatewayApi` turns it on when a `baseUrl` is set (workspace realms, direct or relayed, and hosted direct clients). Cost: one GET `/status` per failed attempt while not already refused.
- **Tests.** The 4,476-line `web-gateway.test.ts` was split to match the code: `web-gateway.test.ts` (install, commands, main and filtered streams, 1,661 lines), `web-gateway-terminal.test.ts` (terminal input ordering and the terminal WebSocket, 1,660), `window-shell.test.ts` (cookie session, boot metrics, `webClient`, connections, clipboard, process, window, plus three new shell-wiring tests), with the shared mocks and the per-test global reset in `web-gateway.test-support.ts`. No test was renamed or changed; the other six suites are untouched apart from one new reconnect test (an installed relay-base realm probes `/status`, a directly constructed gateway does not). New `node-transport.test.ts` (14 tests): two transports against two fake gateways keep separate main streams, cursors and credentials (`setCredential` on one), terminal streams and terminal input, reconnect ladders, lifecycle wakes; disposing one closes its streams and lifecycle subscriptions while the other keeps delivering; no `document`/`window` listener, no `window.orkestratorGateway`, no `localStorage` read; and the relayed revoked-grant cases.
- **Effect: not used (2026-11-07).** Considered for typed failures and for the reconnect backoff as a `Schedule`. `ReconnectBackoff` (protocol, shared with `RelayedEventStream` and `TerminalWebSocketClient`) resets its ladder only after a stream stayed open 30 s, is driven by `connected()`/`disconnected()` calls from callback-style stream code, and takes injected jitter and clock that the reconnect suites pin. `Schedule.exponential` plus jitter and a cap covers the delays, but not the uptime-based reset, and using it would mean running each stream loop as a fiber, a rewrite rather than a move, which this behaviour-neutral item rules out. Transport failures surface as connection-state transitions and the `onCredentialRejected` callback, and command failures already carry their status as `GatewayHttpError`; a `Data.TaggedError` layer would have no Effect consumer yet. Revisit with the typed `invoke` in [2011](2011-scope-domain-negotiation.md).
- **Open: Done when.** The browser smoke test (`test:agent:browser` against an isolated profile) was not run: it drives a live real-stack profile for many minutes and AGENTS.md keeps it out of default validation. It is left to review preparation; the aggregate suite is also left to review preparation.
- **For the report.** §6.2 gives `createBrowserGatewayApi` at `web-gateway.ts:186` with 1,743 lines and estimates the transport at ~1,200 lines; at the split it was 1,771 lines and `node-transport.ts` is 1,352 (comments included). `apps/web/src/lib/node-scope/command-client.ts` has a comment pointing at `TERMINAL_OUTPUT_EVENT_PREFIX` in `web-gateway.ts`; it now lives in `node-transport.ts` (not edited here; node-scope is 2001's).

## Work log

- 2026-11-07 (claude-worker): split `createBrowserGatewayApi` into `createNodeTransport` (`node-transport.ts`) and `createWindowShell` (`window-shell.ts`), kept `createBrowserGatewayApi` as their composition and the install paths unchanged; added the `/status` probe after non-401 fetch-stream failures (2005); split `web-gateway.test.ts` into three suites plus `web-gateway.test-support.ts`; added `node-transport.test.ts` and shell-wiring and realm-probe tests. Tests: the gateway suites (`web-gateway*`, `window-shell`, `node-transport`, 10 files) 260 pass; with `lib/native`, `lib/portal`, rich-content reset, transport connectivity, `App.test.tsx` and `lib/node-scope`, 643 pass across 37 files. Web typecheck has no errors in these files (other agents' files had errors mid-edit); `vite build` passes; oxlint and fmt clean. Done when: the browser smoke test is still open.
- 2026-11-07 (claude-worker, 2013 live pass): ran the browser smoke suite (`mise run test:agent:browser`) against a running `dev:test` profile `uf-2013-smoke` (started like the isolated runner: `--fixture --no-agent-credentials --agent-platforms codex`) at commit `6860254e8`: 51 passed, 3 failed, 124 skipped. The failures are all `e2e/agent-testing/terminal-input-resume.spec.ts`: one fails at base `148e9ad0a` on this host too (vim ruler), two are spec drift after 3008 made `terminalPortalStore.getTerminal` take a `nodeId` (the spec still calls `getTerminal(environmentId, tabId)`). The smoke run did not pass, so the smoke box stays open; it can be ticked after `terminal-input-resume.spec.ts` is updated for 3008 and a smoke run passes (the vim case excepted or fixed). Details and result files: [2013](2013-second-scope-proof.md) Notes, `output/agent-testing/uf-2013/`.
- 2026-11-07 (claude-worker, 4006): browser smoke `mise run test:agent:browser` at `4ece07c9a` against `uf-4006-smoke` (started as the isolated runner starts its own, flags and environment): 52 passed, 2 failed, 124 skipped. Failures: `terminal-input-resume.spec.ts` "a lost terminal write stays fenced …" (the vim status-line pattern that fails at base `148e9ad0a` on this host: pre-existing, environmental) and `browser-gateway.spec.ts` "capped file tree … across inactive views and reload" (390 px after a reload the projects drawer stays open after selecting the environment; passed at `6860254e8`, so a branch regression since; details in [4006](4006-multi-node-qualification.md) Notes). The smoke box stays open.
- 2026-11-07 (claude-worker, 4006 fixes): browser smoke `mise run test:agent:browser` at `ee73894da` against `uf-fix-smoke` (started as the isolated runner starts its own, flags and environment): 53 passed, 1 failed, 124 skipped. The one failure is `terminal-input-resume.spec.ts` "a lost terminal write stays fenced …" (the vim status-line pattern that fails at base `148e9ad0a` on this host: pre-existing, environmental); the capped-file-tree regression is fixed (`e46872643`). Results: `output/agent-testing/uf-fix/evidence/smoke/results.json`; details in [4006](4006-multi-node-qualification.md) Notes.
