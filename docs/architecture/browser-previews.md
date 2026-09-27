# Service Browser Previews

Status: Living. Implemented on branch `webbrowser-functionality-cfc4abe48d47-r1`
(2026-09-23). The execution history and evidence are in
[the implementation plan](../improvements/browser/plan/00-index.md).

A browser tab previews a **service**: a backend-owned identity for one
application port in one environment. It does not preview a host port. The tab
follows the service when a container is recreated or its host binding changes,
and it never follows a reused port to another application.

Every new capability ships **disabled by default**. With everything off, the
product behaves as before: browser tabs use the legacy gateway loopback route.

## Components

| Owner | Module | Responsibility |
| --- | --- | --- |
| Backend | `core/preview-service-registry.ts` | Definitions, generations, lifecycle revocation, events |
| Backend | `core/preview-target-resolver.ts` | Verified Docker/worktree/backend-host targets |
| Backend | `core/preview-readiness.ts` | TCP/TLS/HTTP readiness layers, bounded probing |
| Backend | `core/preview-access.ts` | Scoped attachments, one-use grants, sessions, revocation |
| Backend | `preview-tunnel-server.ts` | Desktop tunnel (`/__orkestrator/preview/tunnel`) |
| Backend | `preview-publication.ts` | Private HTTPS origins, bootstrap host |
| Backend | `preview-relay-supervisor.ts` | Optional in-container relay |
| Backend | `core/commands-registry-previews.ts` | Trusted control commands |
| Protocol | `packages/protocol/src/preview-*.ts` | Contracts, HTTP/1.1 and WebSocket codecs, header policy |
| Desktop | `electron/preview-transport-manager.ts` | Per-service loopback ingress over the tunnel |
| Desktop | `electron/preview-external-handoff.ts` | External-browser handoff without a credential in a URL |
| Web | `stores/previewServiceStore.ts`, `components/browser/*` | Snapshots, service tabs, picker, diagnostics |

## Identity

- `backendInstanceId` is stored in `backend-identity.json` and bound to the data
  directory. Copying a data directory to another path yields a new identity.
- `backendEpoch` changes on every backend start.
- `serviceId` is stable for the life of a definition.
- `endpointGeneration` changes whenever the resolved binding changes: a
  different container, host port, family, or transport. All access for the
  old generation is revoked before the new one is used.

Definitions live in `preview-services.json`. Mutations are compare-and-set on
`definitionRevision`, deduplicated by operation ID, and removals leave
tombstones so clients can detect deletions they missed.

## Registering services

Services are generated automatically from an environment's entry port and TCP
port mappings (`mapping:<port>` keys). Others are registered in **Environment
settings → Preview services** or with `register_preview_service`.

| Target kind | Where the application runs | Port meaning |
| --- | --- | --- |
| `container` | Owned container | The **container** application port. The backend finds the published host port by inspecting Docker. |
| `worktree` | Local environment on the backend host | Backend-host loopback port |
| `backend-host` | Any process on the backend host | Backend-host loopback port (explicit, manual) |

Container targets require the container to carry this backend's owner label
and the environment's ID label. Orkestrator's own ports (gateway, Control MCP,
agent tools, local agent servers, Docker API ports) and in-container agent
servers (4096–4101) are refused with `forbidden`.

**Automatic host ports.** A port mapping with **Auto** (`hostPortMode: "auto"`,
`hostPort: 0`) is published as `127.0.0.1::<port>` so Docker chooses a free
host port. The resolver reads the real binding, so an auto mapping gets a
different host port after recreation without breaking tabs. Adding or changing
a mapping still requires recreating the container.

## Transports

The client chooses a mode from the authenticated `get_preview_capabilities`
response:

- **Desktop app, in-app tab:** desktop tunnel. If the transport is off, it
  falls back to the legacy gateway path. The legacy path rewrites HTML, has no
  WebSocket support, and shares one origin between applications; the tab shows
  these limitations. **Open in browser** uses the private origin.
- **Web and iOS clients:** the private HTTPS origin, opened top-level. Without
  publication, the tab explains the required setup. It never falls back to an
  unauthenticated or embedded view.

The legacy route (`/__orkestrator/browser/loopback/<port>/`) stays available
for old clients.

### Desktop tunnel

For each service it previews, Electron opens a loopback ingress
(`127.0.0.1:<random>`). Each browser connection becomes one WebSocket to the
backend using subprotocol `orkestrator.preview-tunnel.v1`. The WebSocket
authenticates with a scoped attachment credential in the first frame, never in
a URL or header. The backend connects only to that service's current target.
The client never names a host, port, or container.

- The ingress accepts only requests carrying the per-listener
  `x-orkestrator-preview-ingress` header. Electron injects that header for the
  service's own partition and origin, and strips it before forwarding. It also
  checks `Host` against DNS rebinding.
- Each service gets its own Electron partition,
  `persist:orkestrator-preview-svc-<slot>-<connection>-<hash>`, so cookies and
  storage never mix between services. **Reset site data** clears only that
  partition.
- Remote sessions block navigation to client-local and private addresses, so a
  remote preview cannot reach services on the user's own machine.
- Close codes: 4401 unauthenticated, 4403 forbidden, 4409 generation changed,
  4410 revoked, 4429 capacity.

HTTPS upstream services are not carried by the desktop tunnel. They need the
private origin.

### Private HTTPS origins

Each service gets its own host: `s-<hash>.<domain>`, where the hash is the
first 20 hex characters of SHA-256 over the instance and service IDs. There is
also one `bootstrap.<domain>` host. The operator provides:

- a DNS name that resolves `*.<domain>` to the backend's Tailscale address. Use
  split DNS or a private zone. Never use Tailscale Funnel or a public address.
- a certificate and key covering `*.<domain>` (and therefore `bootstrap.<domain>`).
- a listen address. Only loopback or Tailscale addresses are accepted. Public
  binds are refused.

Opening a preview works like this:

1. A trusted client creates a `browser-top-level` attachment and receives a
   one-use grant.
2. The grant is POSTed to `bootstrap.<domain>/bootstrap`. On desktop this goes
   through a one-use loopback handoff page. On the web client it is a form POST.
3. The bootstrap host answers with a 303 to
   `https://s-…/__orkestrator_preview/session?code=…`. The code is one-use,
   expires after 30 seconds, and is bound to that one host.
4. The service host exchanges the code for a host-only
   `__Host-orkestrator-preview` cookie (Secure, HttpOnly, SameSite=Lax), then
   redirects to the application path.

The iOS client cannot POST across apps. It receives the step 3 URL directly
(`create_preview_handoff_url`), which is the same one-use, host-bound,
30-second code. The session code is the only preview credential that ever
appears in a URL. Grants and tunnel credentials never do.

The reserved cookie is removed from requests before they reach the
application, and applications cannot set it. Cross-site writes and WebSocket
upgrades are refused before forwarding. The application's own `Authorization`
headers and cookies pass through unchanged.

Certificates are checked for coverage and expiry. A renewed certificate is
detected and the listener is re-bound on the same port. A certificate that does
not cover the preview hosts disables publication, and capabilities show why.
`publicPort` is the port browsers use when a TLS terminator (for example
Tailscale Serve) listens on a different port than `port`.

### Optional container relay

When the relay is enabled, a container service whose port is **not published**
resolves to `container-relay` instead of `target-unmapped`. The backend runs
one relay per owned container through `docker exec -i -u node`, preferring
`node` and falling back to `bun`. The relay:

- talks only over the exec's stdio. It has no listener and no credential on a
  command line.
- opens only ports registered for that environment. The allow list is updated
  as services change.
- uses per-channel credit windows (256 KiB), so a stalled reader stops only its
  own channel. Each environment is limited to 64 channels.
- exits when its stdin closes: on environment stop, recreate, or delete, on
  backend shutdown, or when the relay is disabled.

A relay crash fails that environment's open channels and backs off
exponentially (1 s up to 30 s). It never stops the backend and never replays
application bytes. HTTPS services are verified over the relay channel as usual.
Images without `node` or `bun` cannot run the relay. For those, publish the
port (Auto is enough) and recreate the container.

## Operator controls

**Settings → Previews** (`get_preview_settings`/`update_preview_settings`),
stored in `preview-settings.json`:

| Setting | Default | Effect |
| --- | --- | --- |
| `transport` | off | **Kill switch for new access.** Off: no new attachments of any kind; existing access continues until revoked or expired. |
| `relay` | off | Enables the container relay; turning it off stops all relays and re-resolves services |
| `publication.enabled` + fields | off | Private HTTPS origins |
| `publication.upstreamCaFile` | none | Extra CA for HTTPS upstreams (added to, never replacing, system roots) |

`ORKESTRATOR_PREVIEW_TRANSPORT=0|1` and `ORKESTRATOR_PREVIEW_RELAY=0|1`
override the stored values. While an override is set, the settings switch
has no effect, so remove it before relying on the switch.

**Revoke all active preview access** (`revoke_preview_access`, optionally with
a `serviceId`) is a separate action. It closes every tunnel, session, and
upgrade and makes their credentials unusable. It does not stop applications,
delete service definitions, or clear application cookies. Rotating the gateway
token also revokes all preview access.

### Rollback

1. Turn **transport** off. Capabilities now report the reason and no new access
   is issued.
2. **Revoke all.** Open tunnels close with 4410 and sessions stop working.
3. Service definitions, applications, and layouts are kept. The legacy gateway
   route keeps working for old clients.
4. Turn off publication or the relay if needed. This affects only
   Orkestrator's own listener and relay processes, not Tailscale settings.
5. Re-enable when ready. Clients get fresh access to the same `serviceId`.
   Nothing that was in flight is replayed.

`tests/unit/electron/gateway-preview.test.ts` ("rollback drill") runs this
sequence against a real gateway.

**Schema downgrade.** Older clients load saved service tabs
(`orkestrator-preview://service/...` in `browserData.url`). They show
"supports backend-local HTTP addresses" and keep the stored value unchanged.
Older backends ignore `preview-*.json` files. Port mappings using Auto
(`hostPort: 0`) are rejected by older backends' validation. Change them to
fixed ports before downgrading the backend.

## Diagnostics

`get_preview_diagnostics` (trusted control API only) returns counts, bounded
failure categories, gauges (tunnel sockets and queued bytes, publication
sockets, relay processes and channels, active admissions), and
p50/p95 connect times. It never contains URLs, paths, queries, headers,
credentials, or page contents. Preview credentials cannot call it. A test
("logs, diagnostics, and events never carry credentials…") enforces this.

Readiness in the picker and in environment settings distinguishes these cases:

- the environment is stopped;
- the port is unmapped (the UI offers **Publish port (auto)**, or the relay when
  it is available);
- the connection is refused;
- TLS failed;
- headers timed out;
- the backend is unavailable.

## Limits

Defaults from `PREVIEW_LIMITS` (`packages/protocol/src/preview-services.ts`):

| Resource | Limit |
| --- | --- |
| Service definitions | 32 per environment, 1,024 per backend |
| Tunnels | 16 per service, 128 per backend, 32 pending handshakes |
| HTTP requests (publication) | 32 active per service, 128 per backend |
| Upgrades (publication) | 8 per service, 128 per backend |
| Tunnel queues | 256 KiB per direction, 64 MiB aggregate |
| Headers | 32 KiB, 100 fields; 30 s to first response header |
| Idle body | 60 s |
| Upload / download | 128 MiB / 512 MiB per request |
| Grants | 60 s, 8 pending per client and service |
| Sessions | 30 min idle, 8 h absolute |

When a limit is exceeded, the request fails with `capacity-exceeded`: HTTP 503
with `x-orkestrator-preview-error`, or tunnel close code 4429.

## Framework configuration

New routes do not rewrite response bodies. Upstream requests carry
`Host: localhost:<application port>`. A same-service `Origin` or `Referer` is
mapped to `http://localhost:<port>`, and `X-Forwarded-Host`/`-Proto` carry the
public origin. So development servers that only accept `localhost` work
unchanged.

- **Vite 7.3.6** (pinned fixture): the page, module graph, and HMR updates work
  over a private origin with an empty config. No `allowedHosts` or `hmr`
  settings are needed (`apps/backend/src/preview-vite.test.ts`, opt-in). The
  HMR client runs over the same transport; its execution in a real browser
  has not been validated.
- **OAuth**: register the service host `https://s-….<domain>` as a redirect
  URI. The desktop ingress port changes each session, so use the private
  origin for OAuth flows.
- Applications that build absolute URLs from `Host` produce `localhost` links.
  Configure them to use `X-Forwarded-Host`, or set their public origin. An
  application that hardcodes a different `localhost` API origin needs that
  origin configured. Both are configuration limitations, not transport bugs.

## Known limitations

- Embedded previews in web and iOS clients are not advertised. They have not
  passed real-browser privacy tests, so those clients open the preview
  top-level.
- Top-level private origins are verified in Chromium only
  (`e2e/preview/private-origin.spec.ts`).
- The following have not been validated:
  - Firefox, Safari, and iOS devices;
  - Docker Desktop;
  - a real Electron window;
  - a two-machine tailnet run.

  See the [evidence log](../improvements/browser/plan/evidence.md).
- An application service worker can intercept the service host's sign-in path
  and block re-sign-in. The sign-in code only authorizes that same service, so
  nothing leaks, but the user must clear the site's data to recover.
- The relay needs `node` or `bun` in the image, and the `node` user.
- Only HTTP/1.1 and WebSockets are carried. HTTP/2-only features, HTTP/3,
  WebTransport, and UDP are not.
