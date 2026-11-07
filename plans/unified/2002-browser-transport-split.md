---
id: 2002
title: "Browser: split createNodeTransport from the window shell API"
phase: 2
plan: "§6.2 step 1 and §12 Phase 2.2"
status: not-started
depends_on: [2001]
blocked_by: ""
owner: ""
branch: ""
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

- [ ] Move the transport parts into `apps/web/src/lib/native/node-transport.ts` as `createNodeTransport(options)`. Options include:
  - `baseUrl` (required, with no global fallback);
  - `credential`;
  - `onCredentialRejected`;
  - `metrics?: TransportMetricsHooks`;
  - `lifecycle?: { onVisibility, onOnline, onPageHide }`, injected by the window so the transport attaches no `document` or `window` listeners itself.
- [ ] Window shell API in `window-shell.ts`: clipboard, webClient (status from the command transport), process, window, connections, boot metrics and cookie-session detection. It wires its hooks into the command transport.
- [ ] Keep `createBrowserGatewayApi` as a thin composition of the two, so `installBrowserGatewayApi` and the realm path are unchanged.
- [ ] Rename across tests only where needed. Keep each test file's coverage, and move tests that belong to the shell into `window-shell.test.ts`.
- [ ] The local desktop path (`installLocalDesktopGateway`, :1675-1707) is unchanged.

## Tests

- [ ] All seven `web-gateway*` suites pass.
- [ ] New: two `createNodeTransport` instances against two fake gateways in one page keep separate streams, cursors, terminals, backoff and credentials, and disposing one leaves the other running.

## Done when

- [ ] The browser smoke test (`test:agent:browser` against an isolated profile) passes with no visible change, and two transports can coexist in a test.
