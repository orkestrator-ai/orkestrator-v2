# Delivery gates and investigation evidence

Status: Proposed implementation sequence plus checks actually performed.

## Suggested delivery sequence

| Phase | Scope | Completion gate |
| --- | --- | --- |
| 1 — Resolve the right service | Stable preview identity, entry/terminal/manual URL resolver, mapping refresh, readiness snapshot | Two containers using the same internal port resolve independently; tabs recover after recreation; inactive environment works. |
| 2 — Repair remote transport | Scoped preview authentication, HTTP/WS target resolution, application auth preservation, timeout/admission limits | Remote Vite HMR and binary application WebSockets work; revocation closes sockets; credential boundary tests pass. |
| 3 — Prove full-origin delivery | Compare dedicated HTTPS origin and desktop tunnel; service/session isolation; no body rewriting on the new path | Routing, storage, cookies, workers, streaming, and application login pass on a real remote backend. |
| 4 — Enable additional clients | One-use bootstrap, external-browser flow, then supported embedded browser/iOS modes | Pass actual Chromium/Firefox/Safari/WKWebView privacy-policy scenarios; unsupported embedding offers a working top-level fallback. |
| 5 — Reduce setup friction | Multiple services, optional discovery, ephemeral mappings, in-container relay | Newly started and container-loopback-only services work without destructive recreation. |

Phases 2 and 3 require an agreed authentication/origin model before coding.
Do not add generic WebSocket forwarding first and leave authorization as a
follow-up. Release the new transport behind a capability negotiation/fallback
so newer clients still work with older backends. Display compatibility mode
limitations rather than silently changing the application's behavior.

Persist new service references alongside migration metadata. Existing URL-only
tabs should remain manual backend-port previews until their environment mapping
can be established unambiguously. An old port must not be guessed to belong to
the currently active environment.

## Acceptance matrix for implementation

Use isolated fixture projects and profiles as required by the
[testing guide](../../development/testing-guide.md) and
[agent-testing guide](../../development/agent-testing.md).

| Scenario | Required observation |
| --- | --- |
| Local worktree and local Docker | Page, assets, API, WS, and navigation work; app/control origins stay separate. |
| Remote worktree and remote Docker on a second machine | No request accidentally falls back to the client's localhost or an unpublished container port. |
| Linux Docker and Docker Desktop | Same service selection works without assuming direct container-IP access. |
| Two containers both using internal port 3000 | Entry button and terminal link reach the correct environment, even when another service owns host port 3000. |
| Container recreation and port reassignment | Existing tab resolves the new generation; old port reuse cannot open a different environment. |
| Server bound to container loopback | Initial mode gives an accurate diagnosis; relay mode can reach it without publishing all interfaces. |
| Additional service and automatic dev-server port increment | Registry updates explicitly; frontend/API dependencies resolve as configured. |
| IPv4-only, IPv6-only, HTTP, and HTTPS targets | Scheme/address family is preserved or rejected with an actionable reason; certificate verification remains enabled. |
| Vite and a second framework | HMR, deep links, SPA history, refresh, dynamic imports, CSS, `srcset`, and source maps work. Pin fixture versions. |
| WebSocket application | Subprotocols, binary/large bounded messages, reconnect, close codes, and slow readers behave correctly. |
| Streaming HTML, SSE, large JS, downloads and uploads | First HTML chunk arrives before completion; SSE progresses; limits and cancellation are explicit; bytes are not corrupted. |
| Bearer/basic app auth and cookie login | App authorization reaches only its app; gateway credentials do not. Test `__Host-`, Secure, Domain, SameSite, duplicate cookie names, and JS-set cookies. |
| Multiple environments under one remote connection | localStorage, IndexedDB, cookies, BroadcastChannel, service workers, and cache do not cross the intended isolation boundary. |
| Hostile preview requests | Other service IDs/ports, control APIs, crafted Host/Origin, cross-site upgrades, forged forwarding headers, and replayed grants are rejected. |
| Headers and representations | CSP/framing behavior is deliberate; SRI, redirects, `no-transform`, 304, 206, compression, and HEAD remain correct. |
| Electron controls | Existing annotations, screenshot capture, DevTools, clipboard, history, zoom, overlays, and native-view bounds still work. |
| External browser | Bootstrap succeeds without Electron hooks or gateway tokens in URLs; expired grants and missing tailnet connectivity explain the next action. |
| Hosted client and iOS | Exercise third-party-cookie blocking, private browsing, app background/foreground, and top-level fallback. |
| Disconnect, token rotation, service deletion | Relevant HTTP requests/sockets are cancelled, grants revoked, capacity released, and reconnect reauthorized. |
| Idle/stalled targets and repeated failures | Connection/header/body policies release capacity; aggregate memory/socket counts stay bounded. |

For every background-sensitive path: start in environment A, switch to B,
allow startup/HMR/disconnect/recreation to occur, return to A, and reload the
client. Verify the authoritative snapshot restores service state and controls
even when no events were observed. Closing a UI tab must not terminate an
application server. Explicit environment stop/delete must still clean up owned
relays and transport resources.

Performance comparisons should record first-byte latency, completed-load time,
HMR delivery, peak buffered bytes, and active sockets for direct, compatibility,
and proposed routes under the same fixture/network conditions. Set targets from
those baselines; this investigation did not measure remote latency or memory.

## Checks performed during this investigation

Repository inspection covered the frontend address/tab/terminal flow, Electron
view/session/auth lifecycle, gateway request/proxy/upgrade paths, Docker port
creation/resolution, and existing gateway and address tests. The production
window/connection partition override was checked, not just the startup helper's
default partition.

The following existing test selections passed using pinned Bun through mise:

```bash
mise run test:logged -- --name browser-investigation-gateway -- \
  bun test ./tests/unit/electron/gateway-proxy.test.ts \
  ./tests/unit/electron/gateway-events.test.ts \
  --test-name-pattern 'browser.preview|preview.referred|preview text|preview bodies|preview bytes|preview client' \
  --parallel=1 --only-failures

mise run test:logged -- --name browser-investigation-addresses -- \
  bun test --cwd apps/web ./src/lib/browser-address.test.ts \
  ./src/lib/environment-address.test.ts ./src/lib/gateway-url.test.ts \
  --parallel=2 --only-failures
```

Passing these tests demonstrates the selected existing behavior, not that the
proposed improvements work. No tests were added or changed. A full application
suite was unnecessary for documentation-only changes.

Direct in-memory probes called the real functions in
[gateway-support-extra.ts](../../../apps/backend/src/gateway-support-extra.ts)
with target `http://127.0.0.1:49152/` and preview prefix
`/__orkestrator/browser/loopback/49152`:

| Input | Observed result |
| --- | --- |
| `fetch("http://localhost:3000/api")` | Unchanged: container port differs from target host port. |
| `new WebSocket("ws://localhost:49152/socket")` | Unchanged. |
| `<img srcset="/small.png 1x, /large.png 2x">` | Unchanged. |
| `fetch("/api")` | Unchanged; relies on separate referrer recovery. |
| `import "/src/main.js"` | Rewritten to import through the preview prefix. |
| `__Host-session=example; Path=/; Secure; HttpOnly` | Cookie Path changed to the preview prefix. |
| Application `Authorization` passed to `sanitizeTargetRequestHeaders()` | Removed. |

These probes used synthetic content and credentials, created no source files,
and did not contact a user's server. They establish helper behavior; actual
browser consequences are either standards-based deductions or acceptance cases
above. No real Docker deployment, remote machine, Electron window, Safari/iOS
session, or production credential was used.

Current upstream documentation was consulted through Context7 for Electron,
Docker, and Vite, and through primary documentation for browser cookie/origin
rules and Tailscale. Relevant links are next to the claims in the
[findings](current-state.md) and [proposal](proposal.md). Current-main API details
are not a substitute for checking installed versions during implementation.
