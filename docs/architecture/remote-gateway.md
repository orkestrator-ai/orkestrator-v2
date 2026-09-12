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

## Connecting `orkestrator.dev`

Both devices must be on the same Tailscale network. The hosted client requires
a tailnet-only HTTPS address; a plain `http://100.x.y.z:34121` URL is blocked
as mixed content.

1. Connect Tailscale on both devices.
2. In Electron, open **Settings > Web client**, enable **Allow web access**,
   and save. The app keeps its existing backend, allows the hosted Orkestrator
   origins, and publishes it through Tailscale Serve.
3. Copy the HTTPS backend address and gateway token from that panel.
4. Open [https://www.orkestrator.dev](https://www.orkestrator.dev) on the same
   tailnet.
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

Local-only development bind:

```bash
bun run --cwd apps/backend start --host 127.0.0.1 --port 34121 --allow-non-tailscale-bind
```

## Vercel-hosted public client

`apps/web-public` is a static frontend. Vercel only delivers the asset bundle.
The browser connects directly to the selected HTTPS backend on the user's
tailnet. Backend traffic is never routed through Vercel.

The hosted origins that must be allowed are `https://orkestrator.dev` and
`https://www.orkestrator.dev`. Electron **Allow web access** and
`mise run start:web-public` both add them.

## Security notes

- The gateway requires a token before serving the app, backend API, event
  stream, or loopback proxy routes.
- Default bind is Tailscale-only. `--allow-non-tailscale-bind` is for local
  development.
- Do not use Tailscale Funnel.
- Do not put the gateway token in a URL, screenshot, log, or chat.
- The token lasts for the current browser tab unless **Remember token** is
  enabled.

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
