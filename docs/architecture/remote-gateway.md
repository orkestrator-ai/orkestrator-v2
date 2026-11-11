# Standalone Backend and Remote Gateway

Status: Living — standalone backend and remote gateway.

The backend in `apps/backend` is the authoritative owner of Docker, terminals,
storage, and agent state. Electron can supervise it, or it can run alone and
serve browsers on the same Tailscale tailnet.

Browser traffic is never relayed through orkestrator.dev or Vercel. Those hosts
only deliver the static client; the browser then talks to the machine that is
running Orkestrator.

## Launch modes

- `mise run dev` starts Electron, which supervises one backend. Electron uses
  an ephemeral loopback control listener. Authenticated browsers use a
  separate browser listener on an OS-assigned free port; the bound URL is
  logged (with a local-only fallback when Tailscale is unavailable).
  Losing Tailscale or a browser-port conflict does not take down the desktop
  control channel.
- `mise run start:web` builds and starts the backend without Electron. The
  backend serves the built React app to authenticated browsers.
- `mise run start:web-public` does the same and also allows the hosted
  Orkestrator origins and publishes the listener through Tailscale Serve.
- `mise run dev:web` runs Vite and the backend together. Open the backend URL
  printed in the logs (normally `http://127.0.0.1:34121/` without Tailscale),
  not the internal Vite URL on port `1420`.

Do not run a standalone backend alongside Electron against the same data
directory. Do not use Tailscale Funnel; the backend is intended to stay
private to the tailnet.

The published package runs the same service with `orkestrator serve` (the
bare `orkestrator --host …` forms keep working). Its client commands
(`orkestrator project list`, `environment start`, …) attach to an
already-running backend through `POST /__orkestrator/invoke` with the bearer
token, using one versioned command, `public_action`; they never start a
backend. Once serving, every backend publishes a mode-0600
`<data dir>/backend-instance.json` naming its endpoint, generation and the
path of its auth file (never the token). See
[public-cli.md](public-cli.md).

To keep a standalone backend running and let remote clients update it, install
it as a user service with `orkestrator service install -- <serve args>`, or
run `orkestrator service install` alone in a terminal to choose Tailscale
Serve, the tailnet address or SSH interactively. That
uses launchd on macOS and systemd on Linux. The service runs versioned releases
through a launcher, which goes back to the previous release when a new one
fails to start. See [host-updates.md](host-updates.md#standalone-service).

## Connecting `orkestrator.dev`

Both devices must be on the same Tailscale network. The hosted client requires
a tailnet-only HTTPS address; a plain `http://100.x.y.z:34121` URL is blocked
as mixed content.

1. Connect Tailscale on both devices.
2. In Electron, open **Settings > Web client**, enable **Allow web access**,
   and save. The app keeps its existing backend, allows the hosted Orkestrator
   origins, and publishes it through Tailscale Serve.
3. Copy the HTTPS backend address and gateway token from that panel.
4. Open [https://www.orkestrator.dev/connect](https://www.orkestrator.dev/connect)
   on the same tailnet.
5. Enter the HTTPS origin as **Backend address** and the token as **Gateway
   token**, then **Connect directly**. Do not add a path, query string, or
   token to the URL.

For a standalone backend without Electron:

```bash
mise run start:web-public
```

Or, without cloning the repository:

```bash
curl -fsSL https://orkestrator.dev/install.sh | \
  bash -s -- --tailscale-serve \
  --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev
```

If Bun is already installed:

```bash
bunx orkestrator \
  --tailscale-serve \
  --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev
```

On macOS, Orkestrator detects `/Applications/Tailscale.app`. If Tailscale is
elsewhere, set `ORKESTRATOR_TAILSCALE_BIN` to the executable.

Copy these two values from startup output:

- The HTTPS address shown by `[gateway.tailscale] available url=`
- The token in the `gateway-auth.json` file shown by
  `[gateway] auth-token.stored file=`

Default token paths:

- macOS: `~/Library/Application Support/orkestrator-v2/gateway-auth.json`
- Linux: `~/.config/orkestrator-v2/gateway-auth.json`

Keep the token private; it grants access to the local backend.

## Service flags and environment

Flags are parsed in `apps/backend/src/options.ts`. Each flag has an
equivalent environment variable unless noted.

| Flag | Environment | Purpose |
| --- | --- | --- |
| `--host` | | Bind address. Default is the first Tailscale address. |
| `--port` | `ORKESTRATOR_GATEWAY_PORT` | Browser gateway port. Default `34121` for the default data directory's backend, and a free port for any other. See [Default gateway port](#default-gateway-port). |
| `--allow-non-tailscale-bind` | | Permit a non-Tailscale bind (local development). |
| `--allowed-origins` | `ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS` | Comma-separated browser origins. Their hosts are also names the gateway answers to. See [Security notes](#security-notes). |
| `--tailscale-serve` | `ORKESTRATOR_TAILSCALE_SERVE=1` | Publish HTTPS through Tailscale Serve. On Linux, run `sudo tailscale set --operator=$USER` once first; otherwise Tailscale answers `Access denied: serve config denied` and the backend exits. |
| `--tailscale-serve-port` | `ORKESTRATOR_TAILSCALE_SERVE_PORT` | Serve HTTPS port. Default `443`. |
| `--tailscale-bin` | `ORKESTRATOR_TAILSCALE_BIN` | Tailscale CLI path. |
| `--compression` | `ORKESTRATOR_GATEWAY_COMPRESSION` | `off`, `body` or `on` (default; adds SSE gzip). See [Compression and terminal transport](#compression-and-terminal-transport). |
| `--data-dir` | `ORKESTRATOR_DATA_DIR` | Application data directory. |
| `--docker-image` | `ORKESTRATOR_DOCKER_IMAGE` | Image tag. Default `orkestrator-v2:latest`. |
| `--control-host` / `--control-port` | | Loopback Control MCP listener. |
| `--loopback-client-port` | `ORKESTRATOR_LOOPBACK_CLIENT_PORT` | Additional `127.0.0.1` client gateway, the SSH forwarding target. `0` picks a free port. |

Local-only development bind:

```bash
bun run --cwd apps/backend start --host 127.0.0.1 --port 34121 --allow-non-tailscale-bind
```

### Default gateway port

Only the backend of the platform default data directory (`isDefaultDataDir`, the
same rule as the [Control MCP port](control-mcp.md)) defaults to `34121`, because
remote machines reach it there. With no `--port` or `ORKESTRATOR_GATEWAY_PORT`,
every other data directory and any `--runtime-flavor agent-test` backend takes a
free port that changes on each start (`implicitGatewayPort` in
`apps/backend/src/options.ts`). `mise run dev` asks for a free port too
(`desktopGatewayPort`). So a second backend cannot move the main install's address
by starting first. An explicit port always wins, on any data directory.

A second backend that remote clients reach needs a stable address, so give it
`--port`. The bound URLs are in `backend-instance.json`, and `orkestrator service
install` prints them. The questions in `service install` offer a port for the
tailnet address.

`service install --data-dir <other> -- --tailscale-serve` without `--port`
writes a free port chosen at install and `--strict-gateway-port`. Reinstalling
keeps a valid nonreserved pin; saved zero, fixed or invalid ports are replaced.
If the pin becomes occupied, startup fails without publishing another target.

Standalone Serve also records ownership atomically in
`<data-dir>/standalone-serve.json` before publishing its root proxy. Older units
and hand-started backends can therefore recover their owned root when a free
port or fallback changes across restarts. On the first update, ownership is
recovered from the last successful `backend-instance.json` (the loopback primary
URL and HTTPS browser URL). Only the matching tailnet-only root is replaced;
other paths survive, and foreign roots and Funnel configurations remain
conflicts. Keep these files when repairing a service. An old service with no
usable ownership evidence needs host-side inspection of its Serve configuration
before removing its stale root; reinstalling with a port alone cannot prove
ownership of an unknown target.

If a non-strict port is taken, the gateway tries the next 20 ports and then a
free one. The walk skips `34121`, `34122`, `ORKESTRATOR_CONTROL_MCP_PORT` and the
loopback client port. Every OS-assigned browser port is also checked against
these reservations and released and retried if reserved. A port asked for by
name is still tried first.

See the [pending release migration note](../development/releasing.md#pending-release-note-gateway-port-migration)
for existing services that remote clients reach directly over the tailnet.

## Compression and terminal transport

`--compression` sets the client listeners' mode
(`GATEWAY_COMPRESSION_MODES` in `apps/backend/src/gateway-support-core.ts`):

- `off`: nothing is compressed.
- `body`: eligible ordinary responses and static assets are
  compressed; event streams are not.
- `on` (default): `body` plus gzip on direct `/__orkestrator/events` streams
  (`GzipEventClientWriter`) and proxied event streams
  (`createSseGzipCompressor`). Each frame, keepalive comment and
  `gateway.keepalive` event is sync-flushed, so delivery stays incremental. A
  client that does not negotiate gzip gets identity. Both kinds of stream send
  `Vary: Accept-Encoding` either way. A proxied upstream that sends
  `Cache-Control: no-transform`, or that already sent a coded body, is forwarded
  as it is.

A proxied body the gateway compresses, or that the legacy browser preview
route rewrites, no longer matches the upstream `ETag`, so the gateway sends a
weak tag derived from it instead of dropping it:
`W/"<upstream tag>|ork:<w|s>:<coding>[:<rewrite key>]"`
(`apps/backend/src/gateway-proxy-etag.ts`). The rewrite key covers the route's
prefix and port and the rewriter's own code, so a tag never revalidates bytes
rewritten for another route or by another build. On `If-None-Match` the
gateway sends the upstream's own tag, exactly as the application issued it,
and answers the application's `304` with the tag the client holds; a derived
tag for another route is not sent upstream. Reloads of a previewed dev server
then revalidate instead of downloading, rewriting and compressing every
module again.

A static file with no precompressed sibling is compressed on the fly, up to
`MAX_STATIC_FALLBACK_SOURCE_BYTES`. Its tags depend only on the source file and
the coding, so a revalidation is compared with them before anything is
compressed (`heldStaticFallbackEncoding` in `apps/backend/src/gateway-proxy.ts`).
A match answers `304` with the variant the client holds and no coded
`Content-Length`, which only compressing would tell us. `If-None-Match: *` and
`If-Modified-Since` alone name no variant, so they still compress first.

Streaming gzip contexts are shared by direct and proxied streams and capped at
`MAX_CONCURRENT_STREAMING_COMPRESSIONS` (8); a stream that finds the pool full
continues in identity and counts as declined. A browser holds two event
streams (the main stream and one shared terminal stream), so four browsers
fill the pool. The direct writer counts its compressor backlog in the
slow-consumer limits. The control listener never compresses
(`compressionModeForListener`).

Terminals use HTTP/SSE unless the browser opts into the terminal WebSocket
(`TerminalWebSocketGateway`, `apps/backend/src/terminal-websocket-server.ts`)
through the `terminalTransport` option or the
`orkestrator-terminal-transport` localStorage key set to `websocket`
(`TERMINAL_TRANSPORT_STORAGE_KEY` in `apps/web/src/lib/native/web-gateway.ts`).
The socket has process-wide socket and channel limits and a per-socket channel
limit, uses no message compression, and is not touched by `--compression`.
Output ACKs are cumulative and coalesced for 1 s; they are advisory, and flow
control reads the socket's buffer instead.

A client offers `orkestrator-terminal.v1.input-results` ahead of
`orkestrator-terminal.v1`. On the former, input that succeeded is answered by a
cumulative `input-results` frame per channel per flush ("everything up to this
id"), and a failure or a resize keeps its own `operation-result`. Input on a
channel completes in id order and collected results go out ahead of any other
control frame, so a cumulative frame never covers an input still in flight or
about to fail. Nothing waits for a batch: the frame goes out in the flush a lone
result would have used, so results merge only when they finish together. An
older client offering only v1, or an older server selecting it, keeps one
`operation-result` per input.

The flush stops moving channel frames to a socket holding 256 KiB and resumes
from the `ws.send` callback, so a backlog stays in its own channel's queue and
the 512 KiB channel limit desyncs only the channel that built it. Control frames
ignore this watermark and have their own hard limit. Several flooding channels
together can still reach the 2 MiB socket limit, which then desyncs whichever
channel has output next, because by then the socket really is behind.

Terminal input and resizes wait on one ordering tail per session, owned by the
gateway rather than the socket, so a plain disconnect still delivers what was
already accepted and a reconnect cannot overtake it. Revocation is the
deliberate exception: credential rotation, gateway stop, and the expiry or
revocation of a socket's own browser session or client grant all refuse
everything still queued, including what a disconnected socket left behind. The
one operation already running in the backend cannot be recalled.

A socket keeps its expiry timer and revocation subscription until its last
queued operation settles, so a queue is still refused if its credential lapses
after the disconnect; each socket kept this way holds an operation, so the
operation limits bound them. A credential still valid at its deadline (renewed
or refreshed) is watched on, open socket or not. `ClientGrantService` tells a
grant's listeners whenever its record goes (one grant, a controller's, all of
them, or found expired), through the `onGrantRevoked` node hook, so a terminal
socket or event stream it authorized closes at once rather than at the grant's
original deadline.

A local desktop window on main's relay takes everything through Electron main:
every backend event, terminal output included, is parsed in main and relayed to
each window, and each command is cloned, stringified, fetched, parsed and cloned
back. By default a new local window uses this gateway itself instead. The
choice is `global.localWindowGatewayTransport` (Settings → Experimental, read
once as each window is created): unset or `true` is the direct transport, and
only an explicit `false` keeps the relay, so a user who turned it off before the
default moved stays off (to-do 4501). The packaged `file://` renderer is
qualified on it by `packaged-security-electron.spec.ts`. On the direct
transport:

- `readLocalWindowGatewayTransport` decides at creation, and `gateway-sync` hands
  the preload the backend's origin. The preload then exposes
  `orkestratorDesktopHost` instead of `orkestrator`, because a context-bridge
  property cannot be replaced. `installLocalDesktopGateway` composes
  `window.orkestrator` from that host and a gateway client, so commands and events
  cross no bridge. File-draft saves and deletes are an exception: they are
  handed immediately to a bounded main-owned IPC queue with per-client CAS
  revision tracking. Queued writes survive renderer reload or close, including
  payloads above fetch keepalive limits; a failed revision fences its successors.
  Native APIs and events main raises itself (menus, connection
  lists, `local-backend-unavailable`) stay on IPC. The window sets no
  `orkestratorGateway`: it is still a local client.
- It talks to the control listener, the origin main already uses, which never
  compresses. Like every web client, it carries all of its terminals on one
  filtered SSE stream; `terminalEventSource` makes that stream an `EventSource`
  even though the window has a `baseUrl`, since main adds the credential below
  the page. The terminal WebSocket stays a separate choice.
- The page never holds the token. `directTransportAuthorization` lets main's
  `webRequest` hook add it for exactly this origin and the `invoke` and `events`
  routes, and the request presents the backend's own origin, which any launch
  answers whatever `--allowed-origins` lists.
- Main relays no backend event to such a window (`relayBackendEvent`), and asks for
  its own stream with `excludeEvents=terminal-output-` while no open window takes
  terminal output from it (`setTerminalOutputRelay`). A window's transport stays as
  it was created, so mixed windows are normal: a relay window keeps main's stream
  unfiltered, and a change restarts that stream from its cursor. Opening it again
  announces `terminal-event-stream-connected`, so a relay window reads its exact
  snapshot. Relayed node events are never on that stream: main takes them on a
  filtered one, for what relay windows listen to
  ([command-nodes.md](command-nodes.md)).

Measured on macOS with nothing attached over the DevTools protocol (2026-11-06,
`local-gateway-transport-cpu-electron.spec.ts`), a direct window costs Electron
main less than a relay window: a 1.29 MB terminal burst shown in two windows
cost main 4–7 ms against 46–54 ms. The pages parse their own streams instead,
so the renderers spend more (137–178 ms against 81–85 ms). The `webRequest`
hook adds no measurable JavaScript time: it runs once per request, and a
stream's chunks do not pass through it. A page driven over the DevTools
protocol reverses the result: each load and stream chunk becomes a DevTools
event that main forwards, which the relay's IPC delivery does not produce
([agent-testing.md](../development/agent-testing.md#measuring-electron-mains-cpu)).

The default became `on` on 2026-11-01, after a live probe through Tailscale
Serve showed no held frames and no re-encoding. `--compression body` is the
rollback. The terminal transport stays the shared SSE stream: on the
single-host matrix of 2026-11-11, `on` SSE carried redundant build output in
about a thirteenth of the opt-in WebSocket's bytes and kept a 512 kbit/s link
at its latency. The measurements, the harnesses
(`apps/backend/scripts/sse-route-probe.ts`,
`apps/backend/scripts/remote-bandwidth-baseline.ts` and
`e2e/agent-testing/remote-bandwidth-live.spec.ts`) and the decisions they
settled are in [remote-bandwidth.md](../development/remote-bandwidth.md).

`apps/backend/tests/gateway-sse-gzip-routes.test.ts` and
`e2e/SseGzipStreaming.spec.ts` prove incremental delivery directly, through
HTTP/1.1 and HTTP/2 test proxies, and in real browsers.

### Through Tailscale Serve

Serve is the reference route for remote measurements, with the direct tailnet
listener as the control. Read from Tailscale's source at v1.102.4 and Go's
`httputil`, not yet measured on a tailnet: Serve is a plain Go reverse proxy,
which flushes `text/event-stream` immediately and does not encode bodies, and it
sets no server write or idle timeout that would end a quiet stream.

One thing does change on that path. Serve leaves Go's automatic transport
compression on, so a client that sends **no** `Accept-Encoding` still costs a
streaming gzip context: the gateway sees Go's `gzip`, and Go decodes it again for
the client. Browsers always send the header, and an explicit `identity` is not
overridden, so only non-browser clients that omit it are affected.

The gateway's keep-alive timeout (`GATEWAY_KEEP_ALIVE_TIMEOUT_MS`, 120 s) must
outlast Serve's 90 s idle timeout for upstream connections, so that Serve is
always the side that closes. When the gateway closed first (Bun's default closes
at about 6 s), a POST that Serve had just put on that connection could fail, and
Go does not replay a POST. Serve then answers with an empty-bodied 502, which the
desktop client reports as `Backend request failed with HTTP 502`, and its log
shows `http: proxy error` with a connection reset, `EOF` or a closed connection.
CPU load widens that race but does not create it. Invoke is not retried to hide
this, because terminal input sent twice would type twice. The evidence, and the
live runs still to do, are in
[4400-gateway-502-under-load-live-evidence.md](../todo/cross-cutting/4400-gateway-502-under-load-live-evidence.md).

`apps/backend/scripts/sse-route-probe.ts` measures whether a route holds or
changes a gzip stream; the steps for a real tailnet, and the 2026-11-01 results,
are in [remote-bandwidth.md](../development/remote-bandwidth.md#running-the-probe-through-tailscale-serve).

A second cause gives the same empty 502: more new connections than the accept
queue holds (`kern.ipc.somaxconn`, 128 on macOS) arriving during even a 10 ms
event-loop stall. The kernel resets the rest, and Serve logs `dial tcp ...
connect: connection reset by peer`. To name the sender, the gateway counts new
connections and requests per second (`apps/backend/src/gateway-traffic-summary.ts`).
When a second holds 100 or more of either, it writes one `[gateway]
traffic.burst` warning per burst, at most one every 30 s, with the top sources,
route classes, client families, listeners and invoke command names. It also
counts how the burst's sockets closed: `closedByPeer` (the client sent FIN
first), `closedByServer` (the gateway ended it: keep-alive timeout,
`connection: close`, shutdown), `closedOnError` (a reset or failed write), and
`singleRequestSockets`, the closed sockets that carried one request. A burst
with many new connections and many single-request sockets is churn; the close
counts say which side causes it. The source
is `X-Forwarded-For`, which Serve sets to the sending device's tailnet address,
believed only on a loopback connection and only as an IP literal; map it to a
device with `tailscale status`. Connections the kernel reset never reach the
gateway, so the counts cover what got through.

## Loopback client gateway (SSH forwarding target)

A desktop client can reach a backend on another machine through a managed SSH
local forward. That forward needs a listener on the remote machine's loopback
that serves the ordinary client API and nothing more.
`--loopback-client-port <port>` (or `ORKESTRATOR_LOOPBACK_CLIENT_PORT`) starts
one. It is an **additional** listener bound to `127.0.0.1` only. It does not
change where the Tailscale or browser listener binds, so an installation that
binds only to its tailnet address keeps doing so.

- It routes like the browser listener: the same gateway token, the same CORS
  rules, and the same terminal WebSocket and preview tunnel upgrades.
  Control-only routes (`/__orkestrator/host-updater`,
  `/__orkestrator/web-client-access`) answer `404` there.
- SSH login never replaces gateway authentication. A request without the
  gateway token gets `401` on this listener too.
- If the port is busy, only this listener fails. The backend logs
  `[gateway] loopback.unavailable …` and keeps serving.
- Its URL appears as `loopbackClientUrl` in the `orkestrator-backend-ready`
  line, and as a `client` entry in the instance descriptor's `endpoints`
  array. A browser listener bound to loopback is listed there as a `client`
  too. The control listener is listed as `control`.
- While it is serving, the authenticated hello
  (`GET /__orkestrator/hello`) advertises the `loopback-client-gateway`
  capability. The hello's `endpointRole` is `client` on this listener and on
  the browser listener, and `control` on the control listener.

**Never tunnel the control listener.** The descriptor's primary `url` is often
the loopback control listener. It also serves the host updater channel and
Electron's web-access control, which are not part of the client API. A managed
SSH route must target a `client` endpoint and must refuse to keep a forward
whose hello reports `endpointRole: "control"`.

Example remote service and forward:

```bash
orkestrator serve --loopback-client-port 34125
ssh -N -L 127.0.0.1:44001:127.0.0.1:34125 build-machine
```

## Machine profile and hello

Each backend owns a small machine profile: a display name, a palette colour
token (never CSS) and a compare-and-swap `revision`. It lives in the
`backend-profile` store. The first read creates it once, named after the host
(`.local` removed, `Orkestrator` if that is blank), with a colour derived from
the installation identity.

- `get_backend_profile` (no arguments) returns it.
- `update_backend_profile` takes `{ expectedRevision, displayName?,
  colorToken? }`. A stale revision fails with a message starting with
  `backend-profile-conflict:` and writes nothing. On success the revision goes
  up by one and the backend emits `backend-profile-changed` with the new
  profile.

`GET /__orkestrator/hello` is the authenticated handshake on every listener
(contract: `packages/protocol/src/backend-profile.ts`). It returns the
installation identity, the generation, the app version, the build commit when
the build has one, the client API range, capabilities, the profile and
`endpointRole`. It never includes data paths,
the auth file, the token or the process ID.

## Vercel-hosted public client

`apps/web-public` is a static frontend. Vercel only delivers the asset bundle.
The browser connects directly to the selected HTTPS backend on the user's
tailnet. Backend traffic is never routed through Vercel.

The hosted origins that must be allowed are `https://orkestrator.dev` and
`https://www.orkestrator.dev`. Electron **Allow web access** and
`mise run start:web-public` both add them.

## Version reminders

The hosted client tracks `main`, the desktop app can connect to another
machine's backend, and a browser tab can outlive a backend upgrade, so a
renderer and its backend can run different Orkestrator versions. Nothing
blocks that, but the renderer compares its bundled version with the backend's
`get_app_version` on load and after every event-stream reconnect
(`apps/web/src/components/BackendVersionReminder.tsx`). On a mismatch it shows
a warning toast saying which side is older and how to update: reload a page
the backend served, update the desktop app (**Check for Updates…**), or update
Orkestrator on the backend's machine. Dismissing it hides it for the session
until either version changes. The Settings **Debug** section shows the same
note. The public CLI has its own schema handshake instead
([public-cli.md](public-cli.md)).

How long each side must cope with an older other side is the support window
in [version-compatibility.md](version-compatibility.md). Within it, transcript
views check each entry's shape at the transcript adapter
(`toPipelineTranscript`, `apps/web/src/lib/chat/transcript-skew.ts`): each run
of entries with no field of a display row (most likely a newer backend's
shape) becomes one muted notice saying how many were not shown and what to
update. Detection is by shape, so it needs no version handshake and never
fires on what a current backend sends. The OpenCode-specific notice for
backends older than 2.19.17 (raw `{ info, parts }` envelopes) was retired on
2026-10-24, because those backends are outside the window.

## Browser connection capacity

A tab watching federated nodes also opens one filtered relayed-event stream.
Together with the main stream this uses two persistent connections per tab,
and terminals can add a third. Plain HTTP/1.1 browsers commonly allow only six
connections per origin: three watching tabs can exhaust that budget and delay
commands. Use an HTTP/2 frontend (for example the supported Tailscale Serve
frontend) for multiple watching tabs. HTTPS alone does not imply HTTP/2.
Cross-tab stream sharing is not implemented; a multi-tab plain-HTTP qualification
is still required before claiming that configuration avoids starvation.

## Event stream reconnects

A web client holds one authoritative event stream and its terminal output
streams. Every client carries all its terminals on one filtered stream
(`includeEvents=a,b,c`): a same-origin browser reads it with an `EventSource`,
and a direct (bearer) or cross-origin client with `fetch`, because an
`EventSource` cannot send a bearer token. One stream per terminal would leave
commands queued behind them on HTTP/1.1, which allows about six connections per
host, and would hold one of the gateway's eight streaming-gzip slots per
terminal. Changing the filter reopens the stream, and every terminal it
already carried is told to re-read its snapshot. A
backend restart drops all of them in every open tab at once, so each stream
reconnects on its own capped, jittered ladder (`ReconnectBackoff` from
`packages/protocol/src/reconnect-backoff.ts`, wired in
`apps/web/src/lib/native/web-gateway.ts`):

- The first retry waits at most 2 s. Consecutive failures double the delay up
  to 16 s, and each delay is drawn from the upper half of its step, so tabs
  drift apart instead of retrying in lock-step.
- A stream must stay open for 30 s, longer than the gateway's 25 s keepalive,
  before losing it counts as a first failure again. A server that accepts
  connections and drops them at once keeps backing off.
- The main stream resumes from its cursor. The gateway's 25 s keepalive also
  advances the cursor: before each keepalive it flushes a cursor frame
  past any events a scoped stream filtered out, so a quiet stream reconnects
  from a current position instead of replaying the filtered range. Terminal
  output has no replay, so
  every terminal stream reopen makes that terminal reload its snapshot. This
  is why terminal retries back off too.
- When the main stream reconnects, terminal streams that are waiting out a
  delay retry at once, so terminals recover with the rest of the UI. A newly
  mounted terminal, or one the user reconnects, also connects at once.
- When the tab becomes visible or the browser fires `online`, the main stream
  and every terminal stream that is waiting out a delay retry at once. A
  hidden tab's timers are throttled, and the outage may have ended
  mid-wait. Nothing happens when no stream is waiting.
- None of these early retries resets the ladder. One that fails waits for
  the next step.
- A same-origin `EventSource` is closed on its first error and rebuilt on the
  ladder from the current cursor. Left alone, a browser retries it by itself on
  a fixed 3 s timer for the whole outage, in step with every other tab the same
  outage dropped. The gateway still accepts `Last-Event-ID`.
- A scoped stream's replay advances through revisions its filter omits with one
  `gateway.cursor` frame per run of them, before the next matching frame or at
  the end of the window. An event larger than the replay ring's byte bound empties
  the window, so reconnecting clients reconcile, and it is counted in
  `replay.ring.oversizedAppends` on `/__orkestrator/metrics`. A scoped client's
  replay is charged against its buffer for what it will be written: matching
  frames and one cursor per run of skips, so a burst of unrelated events no
  longer tells it `replay-too-large`.
- Relayed node events are outside that window. They have a second ring
  (`replay.relayedRing` in the metrics) and, in a renderer, a stream of their own
  with its own cursor, so a busy leaf cannot make a client reconcile
  ([command nodes](command-nodes.md)).
- A link can drop with no answer at all (a tailnet peer that vanished), and then
  an open stream never errors: its socket waits on TCP for many minutes. So
  every client watches for silence. A main stream that shows no sign of life for
  60 s (`GATEWAY_STREAM_SILENCE_LIMIT_MS`, two 25 s keepalives and some slack)
  counts as lost, and an attempt with no answer after 20 s
  (`GATEWAY_STREAM_CONNECT_TIMEOUT_MS`) counts as failed. Fetch-based clients
  (direct browser, Electron) read the keepalive comments. An `EventSource` cannot
  see a comment, so it asks with `keepaliveEvents=1` for a named
  `gateway.keepalive` event, sent once at connect and then on each tick. A
  gateway that ignores the parameter sends none, and the client then does not
  watch that open stream, so an older backend is not taken for a dead link. The
  terminal streams and the terminal WebSocket share the link and have no watchdog
  of their own: the main stream's drops them too, and retries any of their
  attempts still unanswered once it reopens.
- A stream refused with `401` is no outage, because the link is up and no retry
  will help. The state goes back to `connecting` while retries continue, so reads
  run again and show the failure, and a tab signed in with a cookie session
  goes to its login page. An `EventSource` cannot read the status that closed
  it, so an HTTP failure on one asks the same gate with
  `GET /__orkestrator/status`.
- Going offline in the browser pauses and resets nothing, because a local
  backend stays reachable without internet.
- The opt-in terminal WebSocket has its own reconnect owner
  (`terminal-websocket-client.ts`) on the same policy: the socket's first
  retry waits at most 500 ms, consecutive failures double it to 10 s with
  equal jitter, and only a socket that stayed ready for 30 s resets it. A
  denied subscription backs off per terminal on the same jittered ladder and
  resets once the server accepts it. The socket shares the gateway's jitter
  source and clock (`eventReconnectRandom`, `eventReconnectNow`). When it asks
  again for the HTTP fallback, that request waits for the fallback's pending
  retry.
- The main stream's watchdog cannot see a terminal WebSocket that stalls on
  its own, so on each return to the page the client asks the socket itself: a
  server that lists `ping` in its `ready` frame's `features` answers
  `{ type: "ping", nonce }` with a matching `pong`, and the socket is kept when
  that arrives within 2.5 s. Otherwise, or when the server does not list the
  feature, the socket is replaced and every terminal reconciles from a
  snapshot. Hiding the page never touches the socket.
- While the page stays visible, the same server is pinged once the socket has
  been quiet for 10 s (`DEFAULT_TERMINAL_HEARTBEAT_INTERVAL_MS`), and a socket
  that leaves two such pings unanswered is replaced the same way, so a stall
  is noticed 20 to 30 s after its last frame rather than when the user next
  types. Any inbound frame counts as an answer, so a busy terminal sends no
  pings; a hidden page and a server that does not list `ping` get none.
- The main stream reports its state (`eventStreamConnection`: `idle`,
  `connecting`, `connected`, `disconnected`). It stays `disconnected` through
  backed-off retries until a stream opens. The renderer uses it
  to pause presentation reads and show the connection banner (see
  [event-snapshot-recovery.md](event-snapshot-recovery.md#freshness-in-the-ui)).

## Security notes

- The gateway requires a credential before serving the app, backend API, event
  stream, or loopback proxy routes: the gateway token as a bearer header, a
  client grant, or a browser session cookie.
- Signing in with the login form (or a `dev:login` link) sets
  `orkestrator_gateway_auth` to an opaque session id, never the gateway token.
  Cookies are scoped by host, not port, so every other service on the same
  host (a container dev server on a published loopback port, any HTTP service
  on the Tailscale address) receives the cookie; the session limits what that
  exposes. A session that leaks this way still acts as the user until it ends,
  including opening host terminals, but it cannot read or rotate the token.
  This remains accepted on the strength of the observed restricted-container
  firewall refusals, within the qualification limits linked below. Peer binding
  could distinguish a rootful Linux container's own address from a browser
  signed in from loopback or LAN on a direct gateway bind. It does not provide
  consistent coverage: Tailscale Serve and Docker Desktop expose clients as
  loopback, and rootless Linux exposes the host's own address. A `full` mode
  container can reach a gateway the host's firewall lets it reach, so `full`
  mode gives up this protection: on Docker Desktop even at a loopback bind,
  on the tested rootless Linux daemon (host loopback off) at a non-loopback bind
  and at Tailscale Serve's port, and on rootful Linux as far as a host firewall
  such as ufw allows. With rootless host loopback enabled, a `full` container
  reaches every loopback-bound host service, the gateway included, and arrives
  as `127.0.0.1`; restricted runtimes, including ones from images built before
  the egress gateway, were still held to the named service port
  ([record](../development/container-qualification.md#host-loopback-rootful-reach-and-workload-firewalls-on-linux-engine-2026-11-09),
  [pre-gateway images](../development/container-qualification.md#pre-gateway-images-under-the-current-backend-on-rootless-linux-engine-2026-11-11)).
  The remaining Linux checks (a real gateway on a Tailscale address, a
  bare-metal rootful host without a firewall, arm64) are in the
  [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md).
  Observed on Docker Desktop
  ([record](../development/container-qualification.md#project-seed-files-and-gateway-reach-on-docker-desktop-2026-11-04))
  and on Linux Engine
  ([record](../development/container-qualification.md#gateway-reach-and-project-seed-files-on-linux-engine-2026-11-05));
  if a restricted container reaches the gateway elsewhere, revisit this.
- The cookie is `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` when the
  browser reached the gateway over HTTPS (TLS, `X-Forwarded-Proto: https`, or
  a same-host `https:` `Origin`). The gateway reads and strips the
  `__Host-orkestrator_gateway_auth` name too, but does not issue it yet: older
  iOS builds look the cookie up by its plain name (todo
  [2960](../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md)).
- `e2e/preview/gateway-browser-security.spec.ts` (part of
  `mise run test:preview:browser`, served by
  `apps/backend/src/gateway-browser-harness.ts`) checks the parts of these rules
  that depend on the browser: cookie scope across ports, `SameSite=Strict` on
  typed and cross-site navigations, the legacy route's sandbox header on a
  top-level load, and credentials from `Origin: null` (security report cases
  H1, M1 and M2). It runs in Playwright's Chromium, Firefox and WebKit.
  Playwright's WebKit is not shipping Safari, whose own cookie policy sits on
  top of the engine; no harness here drives Safari (`safaridriver` needs
  **Allow Remote Automation** turned on), so Safari is checked by hand.
- Sessions live only in the backend's memory (`gateway-sessions.ts`). A session
  expires after 12 hours without explicit keyboard or pointer activity (the
  client renews through `POST /__orkestrator/session` at most once a minute;
  API polling does not count) and after 7 days whatever the activity; an
  agent-test profile uses 30 minutes and 12 hours. Logout revokes the session,
  token rotation revokes every session, and a backend restart ends them all.
  At most 64 are held; the one closest to expiry is evicted first.
- A cookie never authenticates with the gateway token itself. A browser still
  holding a cookie from a gateway that stored the token there gets the login
  page with "Your browser session has ended", and that cookie is expired in the
  same response. A tab whose session lapses is sent to the login page too.
- `GET` and `PUT /__orkestrator/gateway-settings` (reading or rotating the
  token) need the gateway token as a bearer header. A cookie session, a
  session id sent as a bearer, or a client grant gets `403`, so a browser
  signed in through the login form cannot show the token in Settings → Web
  client; Electron, the hosted client and the CLI send the bearer.
- The gateway answers `421` on every listener, WebSocket upgrades included, to a
  `Host` an attacker could rebind to it with DNS (`gateway-host-policy.ts`). It
  accepts IP literals, single-label names, `*.localhost`, `*.ts.net`, this
  machine's host name and its `.local` form, and the hosts of
  `--allowed-origins`. **Reaching the gateway through a name of your own, such as
  a reverse proxy that keeps `Host`, needs that origin in `--allowed-origins`.**
  This stops a browser, not a client that writes its own headers, which still
  needs a credential.
- Wrong gateway tokens slow down (`gateway-credential-throttle.ts`). A listener
  answers 10 different wrong values, then pauses for 1 s, doubling with each
  further wrong value up to 60 s, and forgets after 15 minutes without a new one.
  During a pause a new value gets `429` with `Retry-After` and is not compared,
  so **the correct token is refused too**; otherwise the one success would give
  a guesser the answer. A guesser can therefore hold off a real sign-in. Still
  exempt are browser sessions, client grants, a connection that has already
  shown the token, and a non-loopback address that has. Repeating a known wrong
  value gets the usual `401` and does not count, so a client left with an old
  token cannot start a pause. Each listener counts alone, so guessing through
  the browser listener leaves the desktop app's control listener alone. Rotating
  the token clears everything. The count lives in memory only, and holds keyed
  digests rather than the values.
- Default bind is Tailscale-only. `--allow-non-tailscale-bind` is for local
  development.
- Do not use Tailscale Funnel.
- Do not put the gateway token in a URL, screenshot, log, or chat.
- The token lasts for the current browser tab unless **Remember token** is
  enabled.

## Live artifacts in remote browsers

Interactive HTML artifacts run on a separate **content origin** served by the
backend's artifact content listener, never on the application origin (see
[transcript-artifacts-runtime.md](transcript-artifacts-runtime.md#content-serving)).
Locally that is the other loopback host name. A remote browser cannot reach
the backend's loopback, so until a content origin is configured, **Run
interactive** is disabled there with the backend's reason; saved previews,
PDF downloads and source stay available.

The content origin must be a **different site** from every application
origin (the backend refuses a same-site origin and reports why in
`transcript_artifact_capabilities().liveInteractiveReason`). Every
`*.<tailnet>.ts.net` name of one tailnet (machine names, Tailscale Services,
other ports of the same name) is one site, so when browsers reach the app
through Tailscale Serve (`https://<machine>.<tailnet>.ts.net`), the content
origin needs a host name in a registrable domain you control. Either side may
use the `ts.net` name, never both.

| Variable | Purpose |
| --- | --- |
| `ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN` | Bare `https://host[:port]` origin browsers load artifact documents from. Must be a different site from the application. |
| `ORKESTRATOR_ARTIFACT_CONTENT_PORT` | Fixed listener port for the TLS terminator to forward to (otherwise it changes every start; a warning says so). |
| `ORKESTRATOR_ARTIFACT_CONTENT_BIND` | Interface the listener binds. Honoured **only** together with `…_CONTENT_ORIGIN`, and only for a loopback or Tailscale address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Wildcard, LAN or public addresses are refused with a warning and the listener stays on `127.0.0.1` (the default). |

Setup with a reverse proxy on the same machine (the listener stays on
loopback):

1. Pick a name in your own domain, for example
   `artifacts.example-private.net`, and resolve it to the backend's Tailscale
   address with split DNS or a private zone. Never use Tailscale Funnel or a
   public address.
2. Terminate HTTPS for that name with a certificate that covers it (the
   hosted client is HTTPS, so an `http:` content origin is blocked as mixed
   content), for example a reverse proxy bound to the Tailscale address that
   forwards to `http://127.0.0.1:34122`. Forward the original `Host` header:
   the listener answers `421` to any host other than the configured origin.
3. Start the backend with:

   ```bash
   ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN=https://artifacts.example-private.net \
   ORKESTRATOR_ARTIFACT_CONTENT_PORT=34122 \
   orkestrator serve --tailscale-serve --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev
   ```

4. Check `transcript_artifact_capabilities`: `contentOrigin` is the configured
   origin and `liveInteractive` is `true`.

If the TLS terminator runs on another tailnet device, also set
`ORKESTRATOR_ARTIFACT_CONTENT_BIND=<this machine's Tailscale IPv4>` so the
listener accepts its connections on the tailnet interface only.

With Tailscale Serve as the terminator for the content origin (for example
`tailscale serve --bg --https=8443 http://127.0.0.1:34122`, origin
`https://<machine>.<tailnet>.ts.net:8443`), the application must then be
reached under a different site (your own domain); a Serve port on the same
`ts.net` name as the application is refused as same-site. The default
`frame-ancestors` are the gateway's real origins (including the Tailscale
Serve URL and allowed web origins) plus the desktop shell;
`ORKESTRATOR_ARTIFACT_FRAME_ANCESTORS` replaces them. The listener has no
application routes and accepts no gateway token or cookies; documents are
reachable only through short-lived capability URLs minted after an ownership
check.

## File and folder pickers

Every place the app asks for a path on the host (project folder, repository
directory, files to copy, SSH agent socket) opens Orkestrator's own picker,
`HostPathPickerDialog`, through `pickHostPath()` in
`apps/web/src/lib/host-path-picker.ts`. The operating system's dialog is never
used: it would browse the client's disk, which is the wrong machine when the
client is connected to a remote backend.

The picker is rendered by the client but lists directories with the
`list_host_directory` backend command (`commands-host-files.ts`), so it browses
the machine the connected backend runs on, whether that is local, a remote
desktop connection, or a browser over the gateway. Listings are capped at
`MAX_HOST_DIRECTORY_ENTRIES`; hidden entries are omitted unless requested; a
stale path falls back to its nearest existing ancestor. New path fields should
call `pickHostPath()`, not add a native dialog.

The picker's **New folder** button creates one folder inside the folder being
browsed with the `create_host_directory` command, then opens it. The name must
be a single path component (no separators, `.` or `..`); missing parents are
never created and an existing entry is reported rather than reused.

The project icon setting uses the picker in file mode, starting in the
project's local path, and reads the chosen image with `read_host_image_file`
(image extensions only, at most 5 MB). Before browsing, when no icon is set,
`find_project_icons` checks the usual favicon, app icon and logo locations in
the project root, common app subfolders, and `apps/*` / `packages/*`.

Out of scope: pickers whose target is not a host path (for example, MCP server
working directories, which can resolve inside a container) and file uploads from
the client's own disk.

## Service previews

Browser tabs can preview registered services through a scoped desktop tunnel
(`/__orkestrator/preview/tunnel` on this gateway) or through private HTTPS
preview origins served by a separate listener. The tunnel is on by default;
private origins need an operator's domain and certificate, so they stay off. See
[browser-previews.md](browser-previews.md) for setup, limits, and the rollback
procedure.

- Preview credentials authenticate only their one service. They never
  authenticate the app, the backend API, the event stream, or the legacy
  loopback proxy.
- Rotating the gateway token revokes all active preview access.
- The legacy loopback proxy (`/__orkestrator/browser/loopback/<port>/`) stays
  for older clients. Every response under it, error and login pages included,
  carries `Content-Security-Policy: sandbox allow-scripts allow-forms
  allow-pointer-lock allow-presentation` in place of the application's own
  policy, the same flags as the client's preview iframe. The page stays an
  opaque origin even when opened top-level, so it cannot call gateway routes
  as the signed-in user. It also has no storage or cookies of its own there;
  applications that need them use the tunnel or a private origin. The web
  client without private origins still loads URL tabs through this route.
  Retiring it is
  [0042](../todo/previews-and-annotations/0042-service-preview-rollout.md)
  task 8.
- The legacy route opens only a port that is the verified binding of an
  enabled preview service of the requesting environment (a container's own
  loopback publication, or a backend-host or worktree listener the resolver
  accepted). The environment is the `x-orkestrator-preview-environment`
  header Electron main sets from the view's tab; a page cannot set it, the
  gateway strips it before proxying, and a request without it is refused.
  Docker's daemon
  ports and Orkestrator's reserved ports (gateway, control MCP, agent tools,
  local bridges) are refused even when a service is bound there; every other
  port answers 403 (security report M2). `Origin: null` gets a wildcard
  `access-control-allow-origin` and never `allow-credentials`.
- Electron's dedicated preview session attaches the gateway credential only
  inside the namespace of the URL the app opened that view on, so a preview
  page cannot carry it to another port by navigating its main frame.
- `ORKESTRATOR_PREVIEW_TRANSPORT` and `ORKESTRATOR_PREVIEW_RELAY` (`0`/`1`)
  override the stored preview settings.

## Troubleshooting

- **Could not reach the backend:** The backend process must still be running,
  both devices must be on the same tailnet, and the address must start with
  `https://` for the hosted client.
- **Site is not in the backend's allowed origins:** Enable web access in
  Electron settings, or start with `mise run start:web-public`.
- **Gateway token was rejected:** Re-read the current `gateway-auth.json`
  `token` value with no quotes or whitespace.
- **`Executable not found in $PATH: "tailscale"`:** Install Tailscale CLI
  integration or set `ORKESTRATOR_TAILSCALE_BIN`.
- **Tailscale Serve fails to start:** Confirm the Tailscale app is connected
  and that HTTPS/Serve is enabled for the tailnet. First-time Serve setup may
  need a tailnet administrator.
