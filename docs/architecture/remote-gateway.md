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
  separate Tailscale listener on port `34121` (or a local-only fallback).
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
it as a user service with `orkestrator service install -- <serve args>`. That
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

- The HTTPS address shown by `[TailscaleServe] Available at`
- The token in the `gateway-auth.json` file shown by
  `[RemoteGateway] Auth token stored at`

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
| `--port` | `ORKESTRATOR_GATEWAY_PORT` | Browser gateway port. Default `34121`. |
| `--allow-non-tailscale-bind` | | Permit a non-Tailscale bind (local development). |
| `--allowed-origins` | `ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS` | Comma-separated browser origins. |
| `--tailscale-serve` | `ORKESTRATOR_TAILSCALE_SERVE=1` | Publish HTTPS through Tailscale Serve. |
| `--tailscale-serve-port` | `ORKESTRATOR_TAILSCALE_SERVE_PORT` | Serve HTTPS port. Default `443`. |
| `--tailscale-bin` | `ORKESTRATOR_TAILSCALE_BIN` | Tailscale CLI path. |
| `--compression` | `ORKESTRATOR_GATEWAY_COMPRESSION` | `body` (default) or `on` (includes SSE gzip). |
| `--data-dir` | `ORKESTRATOR_DATA_DIR` | Application data directory. |
| `--docker-image` | `ORKESTRATOR_DOCKER_IMAGE` | Image tag. Default `orkestrator-v2:latest`. |
| `--control-host` / `--control-port` | | Loopback Control MCP listener. |
| `--loopback-client-port` | `ORKESTRATOR_LOOPBACK_CLIENT_PORT` | Additional `127.0.0.1` client gateway, the SSH forwarding target. `0` picks a free port. |

Local-only development bind:

```bash
bun run --cwd apps/backend start --host 127.0.0.1 --port 34121 --allow-non-tailscale-bind
```

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
  `[RemoteGateway] Loopback client gateway unavailable …` and keeps serving.
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
installation identity, the generation, the app version, the client API range,
capabilities, the profile and `endpointRole`. It never includes data paths,
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

The known symptom of a newer renderer on an older backend is in OpenCode
build-pipeline and Multi Review transcripts. A backend older than 2.19.17 sends
them as raw `{ info, parts }` envelopes, which the renderer no longer
normalizes: most messages vanished and the rest showed as empty rows. The
transcript adapter (`toPipelineTranscript`) now checks each entry's shape
(`apps/web/src/lib/chat/transcript-skew.ts`). Each run of raw envelopes, or of
entries with no field of a display row (most likely a newer backend's shape),
becomes one muted notice saying how many were not shown and what to update.
Detection is by shape, so it needs no version handshake and never fires on
what a current backend sends.

## Event stream reconnects

A web client holds one authoritative event stream and its terminal output
streams. A same-origin browser shares one filtered `EventSource` across all its
terminals; a direct (bearer) client opens one fetch stream per terminal. A
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
- The main stream resumes from its cursor. Terminal output has no replay, so
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
- The browser keeps retrying an `EventSource` itself until it gives up
  (`CLOSED`). The ladder only takes over from there.
- Going offline in the browser pauses and resets nothing, because a local
  backend stays reachable without internet.
- The opt-in terminal WebSocket has its own reconnect loop
  (`terminal-websocket-client.ts`). When it asks again for the HTTP fallback,
  that request waits for the fallback's pending retry.

## Security notes

- The gateway requires a token before serving the app, backend API, event
  stream, or loopback proxy routes.
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

Out of scope: pickers whose target is not a host path (for example, MCP server
working directories, which can resolve inside a container) and file uploads from
the client's own disk.

## Service previews

Browser tabs can preview registered services through a scoped desktop tunnel
(`/__orkestrator/preview/tunnel` on this gateway) or through private HTTPS
preview origins served by a separate listener. Both are off by default. See
[browser-previews.md](browser-previews.md) for setup, limits, and the rollback
procedure.

- Preview credentials authenticate only their one service. They never
  authenticate the app, the backend API, the event stream, or the legacy
  loopback proxy.
- Rotating the gateway token revokes all active preview access.
- The legacy loopback proxy (`/__orkestrator/browser/loopback/<port>/`) is
  unchanged for older clients.
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
