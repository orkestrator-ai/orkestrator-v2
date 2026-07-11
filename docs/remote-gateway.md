# Remote Gateway

The remote gateway lets you use Orkestrator from a normal browser on the same Tailscale network as the desktop host. It is designed for trusted tailnets, not for public internet exposure.

The gateway is started by the Electron main process. It serves the React app, forwards renderer backend calls, streams backend events, and proxies loopback services that normally only exist on the desktop host.

## Requirements

- The desktop app must be running.
- The host must have an active Tailscale address.
- The remote browser must be on the same tailnet and able to reach the host.
- The gateway token must be available on the host machine.

The gateway can be turned on or off in **Settings → Web client**. If no Tailscale address is found, the setting remains enabled but the gateway reports that it is unavailable until Tailscale is connected and the setting is saved again.

## Starting And Connecting

1. Start Orkestrator.
2. Check the app logs for the gateway URL and token file:

   ```text
   [RemoteGateway] Listening on http://100.x.y.z:34121/
   [RemoteGateway] Auth token stored at /path/to/gateway-auth.json
   ```

3. On the host machine, read the token from `gateway-auth.json`, unless you supplied `ORKESTRATOR_GATEWAY_TOKEN`.
4. Open the logged `http://100.x.y.z:34121/` URL from a browser on the same tailnet.
5. Enter the token on the gateway login page.

After login, the gateway stores the token in an `HttpOnly` `SameSite=Strict` cookie named `orkestrator_gateway_auth`.

## Configuration

The gateway supports these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORKESTRATOR_GATEWAY_DISABLED=1` | unset | Disables the gateway completely. |
| `ORKESTRATOR_GATEWAY_HOST` | first detected Tailscale address | Overrides the bind address. The address must still be a Tailscale address. |
| `ORKESTRATOR_GATEWAY_PORT` | `34121` | Overrides the gateway port. |
| `ORKESTRATOR_GATEWAY_TOKEN` | generated token in `gateway-auth.json` | Sets the login token. Must be at least 16 characters. |

Without `ORKESTRATOR_GATEWAY_TOKEN`, the app creates or reuses:

- macOS: `~/Library/Application Support/orkestrator-ai/gateway-auth.json`
- Linux: `~/.config/orkestrator-ai/gateway-auth.json`

Delete that file and restart the app to rotate a generated token.

## What The Gateway Proxies

The gateway reserves the `/__orkestrator` path prefix.

| Route | Purpose |
| --- | --- |
| `/__orkestrator/login` | Token login form and login POST endpoint. |
| `/__orkestrator/logout` | Clears the gateway auth cookie. |
| `/__orkestrator/invoke` | Authenticated backend command bridge used by the browser renderer. |
| `/__orkestrator/events` | Server-sent event stream for backend events. |
| `/__orkestrator/proxy/loopback/<port>/...` | Authenticated proxy to `http://127.0.0.1:<port>/...` on the desktop host. |

All other authenticated routes serve the React renderer. In development, those routes proxy to the Vite dev server. In production, they serve files from the built renderer bundle.

## How The App Uses It

When the renderer is loaded in Electron, it uses the preload IPC API. When the renderer is loaded over HTTP through the gateway, `src/lib/native/web-gateway.ts` installs a browser-backed `window.orkestrator` implementation instead.

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

## Limitations

- Native desktop APIs are limited in remote browser mode. File dialogs return `null`, image clipboard read/write is unavailable, and window drag/close behavior depends on the browser.
- The gateway proxies HTTP loopback services. Services that require a different protocol or direct socket access need a separate access path.
- The gateway relies on the desktop app process. Closing the app stops remote access.
- Apps that set `Secure` cookies over plain HTTP may not persist those cookies in the browser.

## Troubleshooting

### No gateway URL appears in logs

Confirm Tailscale is running and the host has a Tailscale address. Also check that `ORKESTRATOR_GATEWAY_DISABLED` is not set to `1`.

### The browser shows "Authentication required"

The token is missing or wrong. Open the login route again, or clear the `orkestrator_gateway_auth` cookie and re-enter the token.

### The gateway fails to start

Check whether another process is using the configured port. Either stop that process or set `ORKESTRATOR_GATEWAY_PORT` to a free port.

### A proxied environment URL returns a 502

The target service on the desktop host is not reachable on the requested local port. Confirm the environment is running and that its host entry port is populated.

### Remote mode behaves differently from Electron

Check whether the affected workflow depends on a native desktop API. Remote browser mode uses the gateway API and browser fallbacks rather than Electron IPC.
