# Standalone Backend And Remote Gateway

The shared backend lets you use Orkestrator from Electron and normal browsers against one authoritative process. It is designed for trusted tailnets, not for public internet exposure.

The service serves the React app, owns long-running backend state, accepts renderer commands, streams backend events, and proxies loopback services on the backend host. Electron starts and supervises this service with an ephemeral loopback control listener; its separate Tailscale listener can be used by browser clients at the same time. Both listeners share one authenticated backend instance. The identical backend can also run standalone without Electron.

## Requirements

- macOS or Linux. Windows is not supported because terminal sessions use Bun's native PTY.
- Bun, Docker, and the Orkestrator build must be present on the backend machine.
- The host must have an active Tailscale address.
- The remote browser must be on the same tailnet and able to reach the host.
- The gateway token must be available on the host machine.

The service refuses non-Tailscale browser bind addresses by default. The explicit unsafe flag exists only for loopback development. Electron's internal control listener is always restricted to loopback.

## Starting And Connecting

1. Choose a launch mode.

   Electron plus browser access from the same backend:

   ```bash
   bun run dev
   ```

   Local web development in one Turbo invocation:

   ```bash
   bun run dev:web
   ```

   Production-style standalone backend and built renderer:

   ```bash
   bun run start:web
   ```

2. Check the service logs for the gateway URL and token file:

   ```text
   [RemoteGateway] Listening on http://100.x.y.z:34121/
   [RemoteGateway] Auth token stored at /path/to/gateway-auth.json
   ```

3. On the backend machine, read the token from `gateway-auth.json`, unless you supplied `ORKESTRATOR_GATEWAY_TOKEN`.
4. Open the logged `http://100.x.y.z:34121/` URL from a browser on the same tailnet.
5. Enter the token on the login page.

After login, the gateway stores the token in an `HttpOnly` `SameSite=Strict` cookie named `orkestrator_gateway_auth`.

## Configuration

The gateway supports these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORKESTRATOR_GATEWAY_DISABLED=1` | unset | Disables the gateway completely. |
| `ORKESTRATOR_GATEWAY_HOST` | first detected Tailscale address | Overrides the bind address. The address must still be a Tailscale address. |
| `ORKESTRATOR_GATEWAY_PORT` | `34121` | Overrides the gateway port. |
| `ORKESTRATOR_GATEWAY_TOKEN` | generated token in `gateway-auth.json` | Sets the login token. Must be at least 16 characters. |
| `ORKESTRATOR_GATEWAY_COMPRESSION` | `body` | Compression rollout mode. Accepts `off`, `body`, or `on`. |
| `ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS` | unset | Comma-separated browser origins allowed to call the gateway directly. Supports entries such as `https://orkestrator.example` and `https://*.vercel.app`. |
| `ORKESTRATOR_TAILSCALE_SERVE=1` | unset | Makes the backend own a tailnet-only HTTPS listener through `tailscale serve`. The browser listener binds to loopback automatically. |
| `ORKESTRATOR_TAILSCALE_SERVE_PORT` | `443` | HTTPS port configured by backend-managed Tailscale Serve. |
| `ORKESTRATOR_TAILSCALE_BIN` | `tailscale`, or the bundled macOS app CLI when present | Overrides the Tailscale CLI executable path. |
| `ORKESTRATOR_DATA_DIR` | platform application-data directory | Stores projects, environments, configuration, and gateway authentication. |
| `ORKESTRATOR_APP_ROOT` | detected repository/application root | Root used for application assets and development binaries. |
| `ORKESTRATOR_RESOURCE_ROOT` | application root | Root containing packaged bridges and binaries. |
| `ORKESTRATOR_RENDERER_ROOT` | `<app-root>/apps/web/dist` | Built web frontend served to browsers. |

Without `ORKESTRATOR_GATEWAY_TOKEN`, the app creates or reuses:

- macOS: `~/Library/Application Support/orkestrator-v2/gateway-auth.json`
- Linux: `~/.config/orkestrator-v2/gateway-auth.json`

Delete that file and restart the app to rotate a generated token.

The standalone backend also accepts:

```bash
--compression off|body|on
```

Compression configuration resolves in this order:

1. The standalone `--compression` CLI flag.
2. `ORKESTRATOR_GATEWAY_COMPRESSION`.
3. The default, `body`.

When the gateway is embedded, an explicit constructor option takes precedence
over `ORKESTRATOR_GATEWAY_COMPRESSION` and has the same `body` default. Invalid
CLI or environment values fail startup and identify the offending setting.

The modes select:

- `off`: identity responses everywhere. This is the immediate rollback mode.
- `body`: Brotli (preferred) or gzip for eligible renderer assets, dynamic
  JSON, rewritten browser previews, and bounded non-streaming proxy bodies.
  Bodies smaller than 1 KiB remain identity.
- `on`: everything in `body`, plus gzip server-sent events with sync-flush so a
  quiet stream's connected frame and each application frame are decodable
  immediately.

The gateway requests `Accept-Encoding: identity` from loopback proxy targets
and performs any negotiated compression only on the browser-facing hop.
Already encoded upstream responses are passed through without another encoding.
Browser-preview HTML, CSS, and JavaScript are decoded within fixed encoded and
decoded byte and chunk-count limits, rewritten, and then optionally
recompressed. A decoded preview body has no declared size to reserve up front,
so its bytes are charged per chunk against a shared 64 MiB aggregate decode
budget and returned when the downstream response settles; this bounds
concurrency, which the per-request limit alone does not. Dynamic compression
also has bounded source/output sizes and a fixed concurrency limit. Before
buffering a proxied non-streaming body, the gateway reserves one of eight
proxy-buffer slots and the declared body size against a shared 64 MiB aggregate
source-buffer budget. Those reservations are held until the downstream response
finishes or closes and released after every success, failure, abort, or client
disconnect; a response that cannot reserve both limits is streamed as identity.

A buffered body that holds a reservation is also subject to a 30 second idle
timeout, reset by every chunk received. A slow upstream is fine; a silent one is
aborted with `502` so its slot and bytes return to the shared budget instead of
being held until the downstream client gives up.

The gateway does not transform responses to `HEAD`, bodyless status responses,
`206 Partial Content` responses, or responses carrying `Content-Range`. This
preserves empty-body and selected-range semantics. Because nothing is
transformed on those paths, an eligible `HEAD` or `304 Not Modified` keeps
`Vary: Accept-Encoding` alongside the identity metadata its retained
`Content-Length` already describes — including the `ETag` that RFC 9110 requires
a `304` to carry, and `Accept-Ranges`, which stays honest because ranged `GET`s
are passed through untransformed. Only `Content-MD5` and `Content-Digest` are
dropped there: both are defined over the content-coded bytes, which a
corresponding `GET` may well have compressed.

Whenever preview rewriting or compression actually changes representation bytes,
the gateway removes stale `ETag`, `Content-MD5`, `Content-Digest`, `Repr-Digest`,
legacy `Digest`, and `Accept-Ranges` fields rather than forwarding metadata
calculated for the upstream bytes.

Compressed event streams use the same terminal soft-limit desync recovery,
authoritative-event hard-limit disconnect, and keepalive behavior as identity
streams. Their safety accounting measures uncompressed input still owed by the
compressor; it does not rely only on the smaller encoded socket queue. `body`
remains the default until low-volume `on` streams have been verified not to
buffer in a real iPhone and iPad `WKWebView`.

Compression policy follows the listener's role, not its bind address. A browser
listener remains a `browser` listener, and therefore retains the configured
rollout mode, even when `--tailscale-serve` binds it to
`127.0.0.1`. Electron's separate `control` listener always resolves to `off`,
so the gateway never adds response compression on desktop IPC/control traffic.

## What The Gateway Proxies

The gateway reserves the `/__orkestrator` path prefix.

| Route | Purpose |
| --- | --- |
| `/__orkestrator/login` | Token login form and login POST endpoint. |
| `/__orkestrator/logout` | Clears the gateway auth cookie. |
| `/__orkestrator/status` | Small authenticated connection check used by the public client. |
| `/__orkestrator/invoke` | Authenticated backend command bridge used by the browser renderer. |
| `/__orkestrator/events` | Server-sent event stream for backend events. |
| `GET /__orkestrator/metrics` | Returns authenticated privacy-safe gateway counters, byte totals, timings, and recent sanitized samples for milestone measurements. |
| `POST /__orkestrator/client-metrics` | Accepts authenticated, sanitized browser and `WKWebView` boot/resource timing reports. |
| `/__orkestrator/proxy/loopback/<port>/...` | Authenticated proxy to `http://127.0.0.1:<port>/...` on the desktop host. |

All other authenticated routes serve the React renderer. In development, those routes proxy to the Vite dev server. In production, they serve files from the built renderer bundle.

## How The App Uses It

When the renderer is loaded in Electron, it uses the preload IPC API. When the renderer is loaded over HTTP through the gateway, `apps/web/src/lib/native/web-gateway.ts` installs a browser-backed `window.orkestrator` implementation instead.

That browser implementation:

- sends backend commands to `/__orkestrator/invoke`
- subscribes to backend events through `/__orkestrator/events`
- falls back to browser clipboard APIs where available
- returns limited browser-safe fallbacks for desktop-only APIs such as native file dialogs and window dragging

Loopback service URLs are rewritten only in gateway mode. For example:

```text
http://127.0.0.1:7777/session
```

becomes:

```text
http://100.x.y.z:34121/__orkestrator/proxy/loopback/7777/session
```

This is used for Claude, Codex, OpenCode, environment entry URLs, and build-pipeline health checks so a remote browser can reach services running on the desktop host.

## Cookies And Redirects

The loopback proxy keeps gateway authentication separate from target app state:

- the gateway auth cookie is stripped before requests are forwarded to target services
- target services cannot overwrite `orkestrator_gateway_auth`
- target `Set-Cookie` headers are scoped to the loopback proxy path
- target cookie `Domain` attributes are removed
- loopback redirects back to the same target port are rewritten to the matching gateway proxy URL

These rules allow proxied apps to keep their own sessions without receiving or replacing the gateway token.

## Security Model

- The gateway binds only to Tailscale IPv4 `100.64.0.0/10` or Tailscale IPv6 `fd7a:115c:a1e0::/48` addresses by default.
- Every app route, backend command, event stream, and loopback proxy route requires the gateway token.
- Browser login uses an `HttpOnly` `SameSite=Strict` cookie.
- API clients can use `Authorization: Bearer <token>`.
- Backend command requests are limited to JSON object bodies.
- The gateway does not log the token value.

Traffic is plain HTTP because it is expected to travel over Tailscale. Do not bind the gateway to a public interface or expose it through a public reverse proxy.

## Measurement Notes

Both metrics routes require the same gateway authentication as command and event
routes. `GET /__orkestrator/metrics` is read-only; methods other than `GET` are
rejected. `POST /__orkestrator/client-metrics` accepts a small JSON object;
methods other than `POST`, malformed JSON, and oversized bodies are rejected.
The ingestion route keeps only an allowlist of aggregate navigation, resource
size, paint, load, event-stream, platform, and protocol fields. Unknown fields
are ignored, strings and numbers are normalized and bounded, and recent samples
are kept in a bounded in-memory ring.

The snapshot contains bounded route, registered-command, normalized-event,
stream, compression, and boot/resource aggregates. Dynamic metric labels have
fixed cardinality or overflow buckets; unknown commands and uncommon response
encodings are grouped rather than retained verbatim. The metrics are designed
not to contain prompts, terminal contents or output, file contents, attachment
data, credentials, tokens, resource URLs, or other request/response payloads.
Do not add such fields to client reports or metric labels.

Two label rules keep that true as the code grows:

- A command label is retained only when the backend registry actually contains
  that name. Anything else becomes `__unknown__`, so a rejected, network-supplied
  command name is never stored — including when `invoke` refuses for an unrelated
  reason and never consults the registry. The command budget is sized to hold the
  whole registry, because folding real commands into `__overflow__` would make the
  per-command breakdown incomplete and different on every run.
- An event name that embeds an identifier is collapsed to a fixed category
  (`terminal-output`, `terminal-output-tmux`, `claude-state`). Adding a new
  per-entity event name without a matching rule would spend one label slot per
  terminal, container, or environment and evict genuine event names.

Event counters are per delivery, not per emit: a frame written to three
subscribers counts three frames and three frames' worth of `wireBytes`, and an
event with no matching subscriber is not recorded at all. For identity streams,
`wireBytes` is also the transport size. For compressed streams it records
uncompressed application-frame bytes; the route-level `responseBytes` counter
records the encoded chunks actually written to the client. The compression
snapshot's `configuredMode` reports the configured browser-listener rollout
mode. Route encoding buckets and recent route samples report the actual
downstream encoding, so admission, codec, and not-beneficial fallbacks are
recorded as identity rather than as the encoding that was merely negotiated.

## Vercel-hosted public client

`apps/web-public` is a static Vite deployment of the renderer with a backend connection screen. Vercel serves the initial HTML, CSS, JavaScript, fonts, and images only. After that, the browser sends authenticated commands, event streams, and loopback-proxy requests directly to the backend origin selected by the user. There is no Vercel function, rewrite, or relay in the backend traffic path.

An HTTPS page cannot call the gateway's default plain-HTTP tailnet address in normal browsers. The backend can own a Tailscale Serve listener and publish its tailnet-only HTTPS origin:

In Electron, open **Settings > Web client**, enable **Allow web access**, and save. Electron keeps its loopback backend control listener active while the backend creates a separate Tailscale Serve HTTPS endpoint for browser access. Disabling the setting removes that Serve endpoint without stopping Electron, terminals, or agent sessions. The settings panel shows the HTTPS origin and gateway token to enter at `www.orkestrator.dev`.

For a standalone backend, use:

```bash
# Builds the backend, allows https://orkestrator.dev, and enables Tailscale Serve.
bun run start:web-public
```

The script is equivalent to starting the built backend with `--tailscale-serve --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev`. Use the explicit backend command instead when deploying the public client on another origin.

`--tailscale-serve` makes the backend bind its browser listener to `127.0.0.1`, run `tailscale serve --bg --yes --https=443` against that listener, and replace `browserUrl` in its ready message with the resulting HTTPS origin. If `--host` is supplied, it must be exactly `127.0.0.1`. Before changing Serve, the backend checks the selected HTTPS port and refuses to overwrite a listener that already exists; choose an unused port with `--tailscale-serve-port <port>` instead. On graceful shutdown, it removes only the HTTPS listener it configured.

Electron uses the same mechanism in managed mode. Its saved `webClientEnabled` setting controls the Serve endpoint at startup and can be changed while the app is running. Failure to connect Tailscale or configure Serve is reported in settings and does not stop the desktop backend.

Tailscale reports an address similar to `https://workstation.example-tailnet.ts.net`. Enter that origin and the gateway token in the public client. Tailnet ACLs still control which devices can reach the Serve endpoint, and the Orkestrator token remains required. Do not use Tailscale Funnel for this workflow.

The Serve CLI can still be managed separately if preferred. In that case, start the backend with `--host 127.0.0.1 --allow-non-tailscale-bind` and point an externally managed Serve listener at the backend port. The previous spelling of that flag, `--unsafe-allow-non-tailscale-bind`, is still accepted so existing service configurations keep working.

For Vercel, import the repository and set the project Root Directory to `apps/web-public`. The package's `vercel.json` builds the workspace-aware Vite app and serves `dist`. Use the stable production/custom domain in `ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS`; wildcard `https://*.vercel.app` is supported for preview deployments but grants every Vercel subdomain permission to attempt authenticated requests.

For local development:

```bash
bun run dev:web-public
```

The connection selector keeps the backend address in local storage. The gateway token is session-only by default; the user must explicitly choose “Remember token” to persist it in local storage.

## Limitations

- Native desktop APIs are limited in remote browser mode. File dialogs return `null`, image clipboard read/write is unavailable, and window drag/close behavior depends on the browser.
- The gateway proxies HTTP loopback services. Services that require a different protocol or direct socket access need a separate access path.
- A backend started by Electron follows the desktop app lifecycle. A backend started with `bun run start:web` remains independent of Electron.
- Apps that set `Secure` cookies over plain HTTP may not persist those cookies in the browser.

## Troubleshooting

### No gateway URL appears in logs

Confirm Tailscale is running and the host has a Tailscale address. Also check that `ORKESTRATOR_GATEWAY_DISABLED` is not set to `1`.

### The browser shows "Authentication required"

The token is missing or wrong. Open the login route again, or clear the `orkestrator_gateway_auth` cookie and re-enter the token.

### The gateway fails to start

Check whether another process is using the configured port. Either stop that process or set `ORKESTRATOR_GATEWAY_PORT` to a free port.

When Electron owns the backend, a port conflict disables browser access and is shown in Web Client settings, but the desktop app continues through its independent loopback control listener. A standalone backend still exits because it has no separate desktop control channel.

When `--tailscale-serve` is enabled, also confirm that the `tailscale` CLI is installed, its daemon is connected, and HTTPS is enabled for the tailnet. The first Serve setup may require tailnet administrator approval. The backend exits instead of advertising a loopback-only URL when Serve configuration fails.

### A proxied environment URL returns a 502

The target service on the desktop host is not reachable on the requested local port. Confirm the environment is running and that its host entry port is populated.

### Remote mode behaves differently from Electron

Check whether the affected workflow depends on a native desktop API. Remote browser mode uses the gateway API and browser fallbacks rather than Electron IPC.
