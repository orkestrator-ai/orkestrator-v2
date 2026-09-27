# Proposed architecture

Status: Recommendation, not an accepted implementation plan.
See [findings](current-state.md) for evidence and
[validation](validation.md) for delivery gates.

## 1. Give every preview a stable service identity

Introduce a backend-owned preview service registry. A logical service identifies
the backend connection, environment, service name, application port, and scheme.
Its resolved endpoint records the current container/worktree generation,
transport, host port or relay target, readiness, and a revision.

For example, `environment A / web / container port 3000` remains the same
logical service when its host binding changes from `49152` to `49201`. Browser
tabs persist that service reference plus the application path/query/fragment.
They do not use a transient published port as identity. Sensitive URL/history
handling must retain the repository's existing privacy rules.

All entry points use one resolver: the environment browser button, terminal
links, address input, agent-generated links, and open-in-external-browser.
Resolve terminal loopback addresses in their source environment first. For
manual input, make the choice explicit: environment service or backend host
port. Never silently associate an arbitrary host listener with an environment.

Seed the registry from the existing entry port and explicit mappings. Later,
add user-approved service registration, Docker inspection, and development
process metadata. Terminal output can suggest a service but is not authoritative
evidence of ownership or permission to expose it. Avoid scanning all 65,535
ports or logging terminal output as discovery telemetry.

Registry snapshots are authoritative. Live events carry revisions; missed
events trigger reconciliation. Switching environment, unmounting a tab, or
losing a client must not stop the server or destroy its service registration.
Resolve again after container recreation and backend reconnect. Revoke the old
endpoint generation so port reuse cannot silently attach a tab to another app.

Likely integration points:
[environment models](../../../apps/backend/src/core/models.ts),
[command registry](../../../apps/backend/src/core/commands.ts),
[container inspection](../../../apps/backend/src/core/commands-container-exec.ts),
[tab schema](../../../apps/web/src/types/paneLayout.ts), and
[browser address resolution](../../../apps/web/src/lib/browser-address.ts).
The Electron main process owns client-side listeners/views; the backend owns
service identity and remote/container transport state.

## 2. Choose transports independently from the browser surface

| Transport | Best use | Cost and limitations | Recommendation |
| --- | --- | --- | --- |
| Existing gateway path proxy | Basic previews and backward compatibility | Rewrites bodies; weak application-origin fidelity; needs WS/auth fixes | Retain as an explicitly limited compatibility mode. |
| Dedicated preview origin with HTTP/WS reverse proxy | Web, iOS, external browser, and Electron sharing one route | Requires DNS/TLS, scoped auth, and browser cookie-policy design | Preferred cross-client destination. |
| Desktop loopback listener over authenticated remote tunnel | Electron with high compatibility and little remote DNS setup | New tunnel lifecycle; local ports differ from application ports; cookies still need isolation | Prototype as desktop alternative, especially if preview DNS is unavailable. |
| Electron session proxy | Desktop routing while preserving selected URL shapes | Chromium proxy/bypass behavior and external navigation need careful scoping | Spike only; not a web/iOS solution. |
| Browser executing remotely, streamed as pixels | Exact backend-network browser environment | Latency, accessibility, text/clipboard, DevTools, and operational complexity | Defer unless a concrete workflow cannot use normal page delivery. |

Keep the existing `WebContentsView` surface. There is no demonstrated need to
replace it to solve these transport issues. Electron supports dedicated session
partitions and session proxy configuration, but those APIs alone do not provide
an authenticated remote tunnel.
[Electron session API](https://www.electronjs.org/docs/latest/api/session)
documents these capabilities and the effect of closing session connections.

A full-origin proxy removes the preview path from application URLs: `/api`,
`/assets`, and `/socket` all reach the same registered service without body
rewriting. It does not magically fix hardcoded absolute URLs to another
localhost port. Multi-service applications still need an explicit service graph,
reverse-proxy routing, or development configuration for their public API origin.
OAuth callback origins also require application/provider configuration.

## 3. Make origin, storage, and authentication part of the design

Use a preview host distinct from the Orkestrator control/application host, ideally
one host per service. A path prefix is not an origin boundary. In Electron,
partition sessions by connection and environment/service in addition to the
existing window separation, while allowing tabs of the same service to share a
login deliberately. Define storage retention and an explicit reset-site-data
action. Do not reset all preview storage when the user merely switches tabs.

For normal browsers, different ports isolate DOM/origin-keyed storage but not
host cookies. Dedicated HTTPS ports on one Tailscale hostname are consequently
an interim routing option, not complete service isolation. Sibling subdomains
also need protection against parent-domain cookie writes. Reserve and strip
transport cookie names, use host-only secure cookies where available, and keep
preview hosts outside the control application's cookie domain. Stronger
mutually-untrusted-service isolation may require a dedicated domain arrangement
or separate sessions, not just a different path.

These distinctions follow the documented
[origin rules](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)
and [cookie scope rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies).

Authenticate the transport without consuming the application's `Authorization`
header:

1. The trusted client requests access to a registered service through the
   existing authenticated control API.
2. The backend issues a short-lived, narrowly scoped bootstrap grant bound to
   service, endpoint generation, expiry, and intended preview origin.
3. A trusted preview bootstrap endpoint exchanges the one-use grant for a
   preview session. For an external browser, prefer a bounded POST handoff;
   never put the long-lived gateway token in a navigation URL.
4. The preview session authorizes only that service's HTTP and WS traffic.
   The proxy consumes transport credentials and forwards application auth
   separately. The session cannot invoke backend commands or select arbitrary
   upstream hosts/ports.
5. Logout, token rotation, service removal, and backend-generation changes
   revoke relevant access and close associated upgraded sockets. Reconnection
   reauthorizes; it does not assume the previous connection is still valid.

The exact bootstrap mechanism is a prototype gate, not a solved detail.
Requests, referrers, redirects, browser history, logs, and screenshots must not
expose reusable credentials. Restrict bootstrap navigation and its return target;
reject cross-service or replayed grants. Protect cookie-authenticated writes
and upgrades against cross-site requests with explicit origin/CSRF policy.
Cross-origin subresource failures must not become successful HTML login pages.

Hosted Orkestrator embeds a tailnet origin across sites. Browser privacy policy
can block the cookies such an iframe needs even if TLS and CORS are correct.
Partitioned cookies are an option to investigate, not a universal fix for the
application's own login cookies. Ship a first-class top-level external preview
fallback before promising embedded Safari/iOS compatibility.
[MDN's third-party cookie guide](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies)
describes this constraint.

Preserve application CSP and framing policy by default on the new route. If a
site forbids embedding, offer a top-level preview. Any development-only framing
override should be explicit and service-specific. Do not solve compatibility by
globally disabling Electron web security or adding `allow-same-origin` to an
iframe sharing the privileged control origin.

## 4. Plan DNS/TLS deployment rather than assuming wildcard tailnet hosts

Today, the [remote gateway](../../architecture/remote-gateway.md) is private to
the tailnet and the hosted client connects directly to it. Preserve this model;
no public relay is necessary for the first improvements.

Tailscale Serve provides HTTPS for the machine's tailnet name and can select a
listening port. That is a useful building block, but is not evidence that
arbitrary `<service>.<machine>.ts.net` hosts already have DNS and certificates.
A per-service hostname design needs a concrete private DNS and certificate
provisioning plan, or separately provisioned service names. Confirm available
tailnet policy and platform support in a spike.
[Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
and [HTTPS setup](https://tailscale.com/docs/how-to/set-up-https-certificates).

Compare two deployable prototypes:

- Dedicated preview hostnames routed to an authenticated preview reverse proxy,
  with documented DNS, certificate renewal, and tailnet-only reachability.
- An Electron-owned loopback listener that carries traffic through a scoped
  authenticated tunnel to the existing remote backend. Bind only to loopback,
  account for access by other local processes, and authorize the service on the
  remote end. An app closing a view must not accidentally close a listener still
  used by an external browser or another tab.

For a remote machine without Orkestrator, make an explicit product choice:
require a backend installation initially, or later support a managed SSH/local
forward as another registered transport. The current address box is not an SSH
tunnel manager. Do not expand it into an unrestricted backend URL fetcher.

## 5. Implement a complete, bounded preview data path

HTTP and WebSocket handling must use the same target resolver and authorization.
Preserve methods, streaming request bodies, status codes, redirects, repeated
Set-Cookie fields, WebSocket subprotocol negotiation, binary frames, and close
semantics. Strip transport credentials and all relevant hop-by-hop headers,
including headers named by `Connection`. Define trusted Host/Origin/forwarded
header behavior instead of accepting caller-provided forwarding metadata.

For WebSockets, include handshake/connect deadlines, bounded socket counts,
per-service/global queued-byte limits, backpressure, and cancellation on both
ends. Preserve application subprotocols rather than reusing the terminal
protocol. Do not silently replay application messages after reconnect. An
unrecoverable transport gap closes the socket so the application can reconnect
and resynchronize using its own protocol.

For HTTP, stream unchanged representations on the full-origin route. Apply
connection/header deadlines and explicit policies for idle/long-lived bodies;
do not apply a short blanket deadline to healthy SSE or streaming responses.
Bound requests, uploads, rewritten bodies, concurrent operations, and compression
resources independently. Keep slow/disconnected consumers from retaining
unbounded upstream state. Honor `no-transform`, conditional requests, ranges,
content encodings, and integrity metadata.

Gate manual backend-port registration, validate the complete decimal port, and
exclude control listeners, agent bridges, Docker APIs, and unrelated services
unless an explicitly supported workflow requires them. The current authenticated
gateway can address arbitrary loopback ports; new preview grants should not
inherit that authority. Resolve registered targets on the backend and prevent
redirects/DNS changes from escaping the authorized endpoint.

## 6. Improve container discovery without forcing recreation

Initially, reuse Docker's published loopback ports and make the UI explain
container port versus host port. Show all configured HTTP services, not just one
entry port. Support ephemeral allocation for additional mappings so independent
environments need not compete for `3000` or `5173` on the host.

Display readiness as a sequence: environment running, mapping/relay available,
TCP reachable, HTTP response received, and page loaded. Probe with bounded
timeouts and non-mutating requests where appropriate; 401, 403, and 404 can
still prove that an application is reachable. Report bind-address and scheme
mismatches separately. Never claim to know the application's process ownership
from an open port alone.

As a later transport, evaluate a small relay inside each owned container's
network namespace. It can connect to a loopback-only app or a newly chosen
port without changing Docker's published-port configuration. This is separate
from the client-to-backend transport. Authenticate the relay, bound its streams,
verify container ownership, and stop it on environment deletion. Consider a
separate process so application traffic cannot stall agent bridges.

Avoid making direct container-IP access the only solution: it has different
reachability properties on Linux and Docker Desktop and does not reach a
container loopback-only listener. Keep host publication as the simple fallback.

## 7. Make the route understandable to the user

The browser start screen should list services with labels such as
`web · container:3000 · ready` or `api · remote worktree:8000 · starting`.
An expandable route explains backend, environment, application port, and
resolved transport. The address bar shows the application address/path rather
than requiring users to understand a gateway prefix.

Useful controls include Retry, Choose service, Open externally, Copy preview
link, DevTools, and Reset this site's data. Preview-link sharing must describe
its tailnet and authentication requirements; copying a URL must not silently
make a private service public.

Keep server readiness and tunnel state separate from page-loading state. Surface
blocked navigation, unavailable WebSocket transport, expired access, and failed
port resolution with targeted actions. Measure connection time, time to first
byte, HMR reconnects, active sockets, buffer usage, and failure categories using
bounded labels. Do not record page contents, full URLs/query strings, credentials,
or terminal output.
