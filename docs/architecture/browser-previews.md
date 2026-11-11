# Service Browser Previews

Status: Living. Shipped in #831 (`4f02156b`). Rollout gates, the evidence log
and remaining work are in
[0042-service-preview-rollout.md](../todo/previews-and-annotations/0042-service-preview-rollout.md).

A browser tab previews a **service**: a backend-owned identity for one
application port in one environment. It does not preview a host port. The tab
follows the service when a container is recreated or its host binding changes,
and it never follows a reused port to another application.

The desktop tunnel and the container relay are **on by default**; private
origins need an operator's domain and certificate, so they stay off. The
service registry, service tabs and terminal-link intents are always on; with
the transport turned off, a desktop service tab loads the service's current
host port over the legacy gateway loopback route ("compatibility" mode), which
needs a published port.

The defaults apply only to a backend with no saved preview settings. Saved
settings keep their values, because a saved off cannot be told apart from a
deliberate one, so an install that ever saved these settings with the switch off
stays off until it is turned on.

## Components

| Owner | Module | Responsibility |
| --- | --- | --- |
| Backend | `core/preview-service-registry.ts` | Definitions, generations, lifecycle revocation, events |
| Backend | `core/preview-target-resolver.ts` | Verified Docker/worktree/backend-host targets |
| Backend | `core/preview-readiness.ts` | TCP/TLS/HTTP readiness layers, bounded probing |
| Backend | `core/preview-access.ts` | Scoped attachments, one-use grants, sessions, revocation |
| Backend | `preview-tunnel-server.ts` | Desktop tunnel (`/__orkestrator/preview/tunnel`) |
| Backend | `preview-tunnel-mux-server.ts` | Tunnel v2 sessions: many connections per socket |
| Backend | `preview-publication.ts` | Private HTTPS origins, bootstrap host |
| Backend | `preview-relay-supervisor.ts` | Optional in-container relay |
| Backend | `core/commands-registry-previews.ts` | Trusted control commands |
| Protocol | `packages/protocol/src/preview-*.ts` | Contracts, HTTP/1.1 and WebSocket codecs, header policy |
| Desktop | `electron/preview-transport-manager.ts` | Per-service loopback ingress over the tunnel |
| Desktop | `electron/preview-tunnel-session.ts` | Tunnel v2 sessions and streams, v1 fallback |
| Desktop | `electron/preview-external-handoff.ts` | External-browser handoff without a credential in a URL |
| Desktop | `electron/preview-external-forward.ts` | `localhost` forward for the user's own browser (remote backends without a private origin) |
| Web | `lib/preview-link-external.ts` | Routes Cmd/Ctrl-clicked terminal and agent loopback links to a service |
| Web | `stores/previewServiceStore.ts`, `components/browser/*` | Snapshots, service tabs, picker, diagnostics |

## Identity

- `backendInstanceId` is stored in the `backend-identity` store and bound to
  the data directory. Copying a data directory to another path yields a new
  identity.
- `backendEpoch` changes on every backend start.
- `serviceId` is stable for the life of a definition.
- `endpointGeneration` changes whenever the resolved binding changes: a
  different container, host port, family, or transport. All access for the
  old generation is revoked before the new one is used.

Definitions live in the `preview-services` store (see [storage](storage.md)).
Only definitions, idempotency records, the backend identity and operator
settings are persisted; resolved host ports, grants and cookies never are.
Mutations are compare-and-set on
`definitionRevision`, deduplicated by operation ID, and removals leave
tombstones so clients can detect deletions they missed.

## Registering services

Services are generated automatically from an environment's entry port and,
for containers, its TCP port mappings (`mapping:<port>` keys). A local
environment gets only its entry port, as a `worktree` service (see
**Local environments** below). Others are registered in **Environment
settings → Preview services** or with `register_preview_service`. Nothing is
ever generated from a port scan.

| Target kind | Where the application runs | Port meaning |
| --- | --- | --- |
| `container` | Owned container | The **container** application port. The backend finds the published host port by inspecting Docker. |
| `worktree` | Local environment on the backend host | Backend-host loopback port |
| `backend-host` | Any process on the backend host | Backend-host loopback port (explicit, manual) |

Container targets require the container to carry this backend's owner label
and the environment's ID label. Orkestrator's own ports (gateway, Control MCP,
agent tools, local agent servers, Docker API ports) and in-container agent
servers (4096–4102) are refused with `forbidden`. Container targets are reached
only through Docker's loopback binding for that exact application port, and
manual targets are backend-loopback only: an arbitrary remote host is never a
target.

### Local environments

Every local environment of a project carries the same entry port (copied from
the repository config at creation), and they all share the backend host's
loopback, so an open port proves nothing about whose server it is. Loopback
targets (`worktree`, `backend-host`) are resolved with a listener check
(`preview-listener-ownership.ts`):

1. `lsof -nP -a -i4TCP:<port> -sTCP:LISTEN -Fp` (or `-i6`) for the one port the
   definition names, never a range. Linux hosts without `lsof` use
   `ss -H -ltnp -4|-6 "sport = :<port>"`.
2. `ps -A -o pid=,ppid=,lstart=`, then the listener's parent chain up to a
   *managed process root*: a local terminal shell (`TerminalRuntime`) or a local
   agent bridge (`LocalServerRuntime`) this backend started for an environment.
   A dev server run in an Orkestrator terminal, or started by an agent's shell
   tool, descends from one.

The answer is the endpoint's `listener` field: `this-environment`,
`other-environment`, `unattributed` (no managed ancestor: another terminal app,
another user, a system service), `none`, or `unchecked` (neither `lsof` nor
`ss`, a timeout, or a platform other than macOS and Linux).

| Listener | Generated `worktree` service | User `worktree` service | `backend-host` service |
| --- | --- | --- | --- |
| `this-environment` | `managed-process` | `managed-process` | `managed-process` |
| `other-environment` | refused | refused | `user-registered` |
| `unattributed`, `none`, `unchecked` | refused until confirmed | `user-registered` | `user-registered` |

Refusals are `target-unverified`. `managed-process` means "started under this
backend's terminal or agent for that environment", not cryptographic proof.
Its binding key includes a digest of the listener's pid and start time, so a
restarted server on the same port gets a new endpoint generation and old
attachments are revoked. A `user-registered` target shows whatever listens on
the port, and route details say so.

A full check is reused for the registry's 5-second verification window, but a
`managed-process` target also keeps the listener pids it was verified against.
Every new upstream connection inside the window repeats step 1 alone (coalesced
per port and family, no `ps` walk) and compares them. Different pids, no
listener, or a lookup that cannot answer send it through the full check, so a
fast restart gets a new generation, and another environment's server on the
freed port is refused, before the connection opens. Passing the lookup does not
extend the window. Taking an idle socket from the upstream pool opens nothing
and looks nothing up: it stays on the process it was opened to.
`user-registered` and container targets are reused for the window with no
lookup, as before.

A generated local service waits for its own server. While refused for
`none`, `unattributed` or `other-environment` it is re-resolved on the
readiness backoff schedule (1, 2, 4, 8, 16, 30 s), and **Retry** restarts it.
**Show any process** (an empty `update_preview_service` patch) confirms it:
any edit flips `userOverride`, which makes it the user's own registration.

**Port increments.** When a dev server finds its port taken and moves to the
next one, open the address it prints in a preview tab from the terminal
(⌘⇧-click, or ⌘-click when Settings → Browser previews defaults links to preview
tabs).
The link resolves in that environment; an unregistered port offers **Move `<service>`
from port A to B** for nearby services of the same kind and scheme, next to
**Register**. Nothing moves without that click.

**Agent links.** In an environment's agent tab, ⌘⇧-click (Ctrl+Shift-click) on
a loopback link opens a preview tab with the `agent-link` intent, resolved in
that environment like a terminal link. A plain click uses the external-link
router: on remote desktop connections a registered service opens externally,
and an unresolved port opens a preview tab. Coordinator and mail transcripts
have no environment and keep the plain behaviour.

**`orkestrator environment exec` is not a managed root.** A dev server started
through `environment exec` runs under a detached exec worker keyed by the
operation, not the environment, so it is `unattributed` and its seeded service
waits for **Show any process**. This is deliberate (to-do 0045 task 2, decided
2026-11-11). The worker records the child's pid, process group and start time
in its own state file, but the backend holds no live handle to it, which is
what makes terminal and bridge roots safe against pid reuse; exec runs are
also bounded (30-minute default, 6-hour cap) rather than meant for
long-running servers. Revisit only if CLI-driven setups report the one click
per seeded service as a real cost; the change would need the
operation-to-environment mapping and a `ps` start-time check against the
persisted `childPid`.

**Qualification.** The in-app checks (wait state, two environments on one
port with the move offer, restart and fast restart inside the verification
window, agent links, framework hints) are
`e2e/agent-testing/service-preview-seeded-electron.spec.ts`, run on macOS
(`lsof`) and headless on Linux through both `ss` and `lsof`; the runs are in
the evidence log of
[0042](../todo/previews-and-annotations/0042-service-preview-rollout.md#evidence-log).
The design decisions behind this section were recorded in to-do 0045, retired
2026-11-11 (read it with
`git show 498b68766:docs/todo/previews-and-annotations/0045-preview-service-discovery.md`).

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
  these limitations. **Open in browser** uses the private origin when the
  backend publishes one. A remote backend without one gets an
  [external-browser forward](#external-browser-forward) on `localhost`
  instead.
- **Web and iOS clients:** the private HTTPS origin, opened top-level. Without
  publication, the tab explains the required setup. It never falls back to an
  unauthenticated or embedded view.

The legacy route (`/__orkestrator/browser/loopback/<port>/`) stays available
for old clients and legacy URL tabs. It opens only a port that is the
verified binding of an enabled service of the requesting environment, and
never a reserved port (`PreviewRuntime.legacyLoopbackPortAccess`); any other
port answers 403, so a backend-host port must be registered as a service of
the tab's environment before a legacy tab can show it. The renderer passes the
tab's environment with the attach call, and Electron main names it in the
`x-orkestrator-preview-environment` header on the view's authenticated
requests; a request without it (an older desktop app) is refused. A legacy URL tab whose loopback port
belongs to exactly one enabled, available service of its own environment in
the current backend epoch offers **Open as service**. The click re-reads the
service list and converts the tab only if the same service still has the
same endpoint generation, keeping the path, query and fragment
(`legacyUrlServiceMatch` in `apps/web/src/lib/preview-service-entry.ts`).
Ownership is never inferred from the port alone or from the active
environment, so ambiguous tabs get no offer.

On the desktop with the tunnel available, a matching tab converts by itself when
it becomes active, so stored legacy tabs migrate without a click. Web clients
and desktops with the tunnel off keep the button: a web client's service tab
needs publication, and a tunnel-less conversion would load the same route. A
`localhost` URL never matches, because the snapshot does not establish which
address family the legacy view used, so those tabs stay URL tabs. A migrated tab
moves to the service's own partition, so its cookies and storage from the shared
legacy partition do not come with it.

### Desktop tunnel

For each service it previews, Electron opens a loopback ingress
(`127.0.0.1:<random>`). Each browser connection becomes one stream on a
WebSocket to the backend using subprotocol `orkestrator.preview-tunnel.v2`:
one authenticated WebSocket per attachment carries every connection of that
service (`preview-tunnel-session.ts`, `preview-tunnel-mux-server.ts`; the wire
contract is in `packages/protocol/src/preview-tunnel-mux.ts`). The WebSocket
authenticates with a scoped attachment credential in the first frame, never in
a URL or header. The backend connects only to that service's current target.
The client never names a host, port, or container.

v2 is negotiated. A backend that speaks it advertises `multiplexSubprotocol`
in the attachment's tunnel descriptor, and the desktop then offers v2 before
v1. Against a backend that predates v2 (no advertisement), or one that answers
v1 anyway, the desktop opens one `orkestrator.preview-tunnel.v1` WebSocket per
connection, as before. Backends serve both.

- The ingress accepts only requests carrying the per-listener
  `x-orkestrator-preview-ingress` header. Electron injects that header for the
  service's own partition and origin, and strips it before forwarding. It also
  checks `Host` against DNS rebinding.
- Each service gets its own Electron partition,
  `persist:orkestrator-preview-svc-<slot>-<connection>-<hash>`, so cookies and
  storage never mix between services. Tabs of one service in one window share
  the partition and the listener; different windows or connections never
  share. **Reset site data** clears only that partition, and never runs on a
  tab switch.
- Partitions nothing can use again are ended by Electron
  (`PreviewPartitionRetention`, `preview-partition-retention.ts`), because the
  backend knows nothing about client partitions. A minute after a window's
  preview transport starts, and every 30 minutes while it lives, Electron
  fetches its backend's full, unfiltered `get_preview_services` list and
  clears that connection's service partitions (in every window slot) whose
  service is gone. Forgetting a connection clears all its service partitions,
  and its shared legacy partitions once no window uses it. Clearing goes
  through the Electron session (storage, cookies, service workers, caches);
  the emptied directory is removed on the next start, before any session
  exists (`preview-partitions-pending.json`). A partition a live transport
  or window holds is never touched; a filtered, not-modified or failed list
  clears nothing. Partitions are listed before the list is fetched, and service ids
  are never reused, so a service created meanwhile is never a candidate.
  Forgotten connection keys are recorded durably in
  `preview-partitions-pending.json.forgotten` before clearing starts. An
  independent retry owner attempts at most 64 clears per pass, including
  failures, even after every transport closes. Failed clears and held
  partitions remain eligible; retries rotate candidates so failures cannot
  starve the rest. At startup, the whole-connection journal also identifies
  directories whose clear never completed. They can be removed before any
  preview session exists. A failed removal retains the connection intent;
  it never counts as evidence of a successful native clear. The per-directory
  journal admits at most 1,024 entries until startup removes them, and the
  forgotten-key journal refuses admission at 1,024 keys without evicting
  earlier cleanup intent.
- A node scope's previews (`node-previews.ts`) are keyed to its node
  (`node:<nodeId>`), not to a connection. Each time a window opens a node's
  preview runtime, Electron records in
  `preview-partitions-pending.json.nodes` which command connection it reached
  the node through. The same window schedule that reconciles services also
  fetches that command node's `list_nodes`; once every command connection
  that listed a node has dropped it from a full, unsuspended registry, the
  node's service and shared partitions are forgotten like a connection's. An
  unreachable, suspended or malformed registry is no evidence of removal. A
  command handover moves the source's nodes to the target before the source
  drops them, and forgetting a command connection forgets nodes reached only
  through it. A node opened again after removal leaves the forgotten and
  pending journals, so its new site data survives the next start.
- The listener first binds the port it used last for that service (bind, never
  probe-then-close), so origin-keyed storage such as localStorage usually
  survives a restart. If the port is taken, a fresh one is used and that
  storage is lost.
- A window's previews belong to the connection they were opened on. Their
  transport invokes and tunnels to that connection's backend, never to
  whichever backend the window uses now. When the window moves to another
  connection (choosing one, adding one, or forgetting the current one), its
  previews end and their attachments are released on the backend that issued
  them; a window close releases the same way
  (`apps/desktop/electron/preview-connection-backend.ts`).
- Remote sessions block navigation to client-local and private addresses, so a
  remote preview cannot reach services on the user's own machine.
- Close codes: 4401 unauthenticated, 4403 forbidden, 4409 generation changed,
  4410 revoked, 4429 capacity.
- The view owns its path. A link, a redirect or Back moves the view first, and
  the tab learns the new path from a state event. Every state carries
  `service.navigation`, a per-view count of main-frame navigations (a history
  move counts the moment it starts). The renderer sends each attach with the
  count its path was chosen against (`navigationBasis`), and main navigates
  the view only for a path chosen against its latest navigation. A bounds or
  visibility re-attach still carrying the previous path, or a late echo of the
  tab's own earlier save, therefore never undoes a navigation. Renderers that
  send no basis fall back to navigating only for a path they have not already
  asked for. Legacy URL tabs follow the same rule since 2026-10-25: their
  states carry `navigation` and their attaches `navigationBasis`
  (`attachUrl` in `browser-preview-manager.ts`).
- A URL tab's attach also carries the tab's environment identity
  (`environmentId`). A tab never changes environment, so an attach with a
  different identity, null included, is taken for a different tab: main removes
  the view and creates a new one, deliberately discarding its history, so the
  new documents keep none of the old environment's access. A synthetic attach
  in a test must therefore send the same identity the renderer sends, or Back
  history is lost (the legacy URL tab Back case in
  `e2e/agent-testing/service-preview-electron.spec.ts` once failed this way on
  every platform).
- The rule has a renderer half. A state whose count equals the basis of the
  path the tab chose still reports the page being left: main sends one as a
  load starts, before anything commits. The tab keeps its chosen path until the
  count moves, because adopting the old one re-attaches it against the same
  basis and cancels the load. A load that fails therefore leaves the address it
  was asked for next to its error.

HTTPS upstream services are not carried by the desktop tunnel. They need the
private origin.

### External-browser forward

A desktop window connected to another machine can open a service in the
user's own browser without a private origin (no domain, DNS or certificate):
Electron opens a second loopback listener for the service and the browser
loads `http://localhost:<port><path>`. It shares the service's attachment,
tunnel and connection pool with the in-app ingress, and holds the service like
a tab does (`forwardExternally` in `preview-transport-manager.ts`).

- **Which route.** `openServiceInExternalBrowser` uses the private origin
  whenever `browserTopLevel` is available, and the forward only for a remote
  connection without it. A local connection keeps the private-origin path.
- **Links.** A loopback link opened externally from a terminal (Cmd/Ctrl-click
  by default; Settings → Browser previews can swap it with Cmd/Ctrl+Shift-click), or a
  clicked one in agent chat, is resolved in its source environment
  (`resolve_preview_target`, as for a preview tab). A single registered
  service opens through **Open in browser**'s route. An unregistered or
  ambiguous port opens a preview tab, where the user registers or picks it.
  With preview access off, an older backend, or a failed forward, the link
  falls back to the gateway path proxy (`/__orkestrator/proxy/loopback/<port>`)
  of the node running the environment and a toast says why (including
  unavailable capabilities or failed resolution). A leaf's link goes through
  the leaf's own proxy on its current route (`resolveExternalLoopbackUrl`: the
  browser lease's relay, or the route main reports in `nodes.gateway`), never
  the command node's; with no route it is not opened and a toast says so. A
  worktree link (or one from an environment the window does not know) whose
  node is this computer (`backendOnThisDevice`) opens as written: its port is
  already reachable here, and the command node's proxy would reach that
  machine's port instead. A container's link still resolves to its service,
  because the container's port is published on a different host port.
- **Port.** On platforms with exclusive loopback binding, the forward prefers a
  browser-safe application port, so absolute `localhost:<port>` URLs and OAuth
  callbacks keep working. It binds 127.0.0.1 and ::1 together on one port, so
  `localhost` can never reach a
  different local server on the other address family; if either is taken it
  uses another browser-safe free port on both. macOS/BSD always use an
  OS-assigned port to avoid shadowing wildcard listeners through SO_REUSEADDR.
- **Lifetime.** It closes after ten minutes with no open connection (an open
  page's HMR WebSocket keeps it alive), when its service retires, and when the
  window's transport is disposed.
- **What it gives up.** Services share the `localhost` site, so they are not
  isolated from each other the way private origins are, and a page sees the
  user's other `localhost` cookies, as it would running locally.

Never open a remote dev server on the gateway's own host name (for example
`http://<machine>.<tailnet>.ts.net:3000`). Cookies ignore ports, so the page
would receive `orkestrator_gateway_auth`; the gateway path proxy and the
forward both keep it away from the application.

### Private HTTPS origins

Each service gets its own host: `s-<hash>.<domain>`, where the hash is the
first 20 hex characters of SHA-256 over the instance and service IDs. There is
also one `bootstrap.<domain>` host. The operator provides:

- a DNS name that resolves `*.<domain>` to the backend's Tailscale address. Use
  split DNS or a private zone. Never use Tailscale Funnel or a public address.
- a certificate and key covering `*.<domain>` (and therefore `bootstrap.<domain>`).
- a listen address. Only loopback or Tailscale addresses are accepted. Public
  binds are refused.

Choose a preview domain on a different site from Orkestrator itself. A preview
host that is same-site with the gateway can send it same-site requests and set
cookies on the shared parent domain (cookie tossing). Publication compares the
domain against the application's own origins (gateway, Tailscale Serve, web
client and allowed origins) and, when they share a site, still serves but adds
a `warning` to the publication status, shown under the publication settings,
and logs `preview/publication.same-site` once per configuration. It warns
rather than refuses because the site comparison is an approximation without a
public suffix list and some tailnet deployments have no other domain. Each
tailnet name under `ts.net` counts as its own site, as on the Public Suffix
List: `preview.<tailnet>.ts.net` warns when Orkestrator is served from
`<machine>.<tailnet>.ts.net`, and a different tailnet does not
(`apps/backend/src/core/host-site.ts`).

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

The bootstrap host never serves application content, so no application
service worker can be registered on it. A worker on the service host can
intercept the session redirect, but the code only yields a session for the
service whose code it already runs. Bootstrap responses are `no-store` with
`Referrer-Policy: no-referrer`, and the web client submits the grant as a
no-referrer form POST from a pre-opened top-level window, so it never reaches a
URL, history entry or `Referer`. Paths under `/__orkestrator_preview/` are never
forwarded upstream.

The reserved cookies (the preview cookie and `orkestrator_gateway_auth`) are
removed from requests before they reach the application, and upstream
`Set-Cookie` fields using a reserved name are dropped. Upstream `Domain`
attributes are removed, so application cookies become host-only rather than
widened. The preview listener has no control dispatch, so control cookies are
never valid on preview hosts. Cookie-authenticated writes and WebSocket
upgrades must carry a same-service `Origin` (or `Sec-Fetch-Site: same-origin`)
and are refused before forwarding otherwise. Reads (`GET`, `HEAD`, `OPTIONS`)
are checked too, because every service host is same-site with its siblings and
the `SameSite=Lax` cookie rides their subresource requests. With
`Sec-Fetch-Site: same-origin` or `none` they pass. From any other site or
service only a top-level document navigation (`Sec-Fetch-Mode: navigate`,
`Sec-Fetch-Dest: document`, not a `Sec-Purpose: prefetch`) passes, so links,
redirects and the sign-in chain keep working while fetches, images, scripts,
frames and workers get `403` before forwarding. Without Fetch Metadata a
foreign `Origin` is refused. All of these count as `http.rejected{forbidden}`
(`crossSiteViolation` and `crossServiceReadViolation` in
`packages/protocol/src/preview-header-policy.ts`). The application's own
`Authorization` headers and cookies pass through unchanged.

External-browser access is its own attachment with a session lease (30 minutes
idle, 8 hours absolute). It outlives the tab that opened it and ends on service
removal, an endpoint generation change, the access kill switch or credential
rotation.

The proxy reuses upstream connections (`apps/backend/src/preview-upstream-pool.ts`).
After a cleanly framed response, the connection is kept idle for the access
(attachment), endpoint generation and target it was opened for, and only that
access reuses it. Every request still re-checks the access and resolves the
target first. The pool is registered with the access service, so revoking or
expiring the access, or a new endpoint generation (which revokes the old
generation's access), closes the idle connections at once; a registry
revocation also drops the service's pool directly. An idle connection that
receives data or EOF is closed, never handed out. A safe request with no body
(`GET`, `HEAD`, `OPTIONS`) whose reused connection turns out to have been
closed before any response is sent once more on a fresh connection; no other
request is retried. Upgrades always use a fresh connection. Application
`ETag`s pass through unchanged on this route.

Certificates are checked for coverage and expiry. A renewed certificate is
detected and the listener is re-bound on the same port. A certificate that does
not cover the preview hosts disables publication, and capabilities show why.
`publicPort` is the port browsers use when a TLS terminator (for example
Tailscale Serve) listens on a different port than `port`.

### Optional container relay

While the relay is on (the default), a container service whose port is **not published**
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

## Security boundaries

Application code is untrusted relative to Orkestrator control and to other
services. Its authority is exactly the service being previewed. Every change
to the preview path must keep these boundaries:

- **Local ingress is credentialed.** Port secrecy is not authentication. The
  desktop ingress requires `x-orkestrator-preview-ingress`, which Electron main
  injects through `webRequest` only for requests from that service's partition
  to that listener's origin (HTTP and WS). The header is stripped before bytes
  enter the tunnel. Other local processes get `403`.
- **The external-browser forward is the one uncredentialed ingress.** An
  external browser cannot be made to send a credential, so the forward is
  bounded instead: loopback binds only, a `Host` of `localhost`, `127.0.0.1`
  or `[::1]` on its own port (no DNS rebinding), Fetch Metadata that lets
  non-loopback sites only navigate to it (no foreign-site fetches, frames, writes or
  WebSockets; `externalForwardSiteViolation`), reserved cookies stripped, and
  an idle shutdown. That is the exposure of a dev server run on the user's
  machine. It exists only for remote connections and only while the user has
  opened a service with it. Requests with a loopback Origin are allowed across
  loopback hostnames and ports; the application still enforces its own CORS policy.
- **The tunnel cannot choose destinations.** An attachment is bound to
  `(serviceId, backendEpoch, endpointGeneration)`. An `OPEN` frame carrying
  host or port fields is malformed. The backend re-resolves the upstream and
  re-checks the generation immediately before connecting; a changed generation
  fails the `OPEN`.
- **Gateway credentials never ride application traffic.** The tunnel
  authenticates in-band with its own credential, and browser sessions use the
  host-only preview cookie. The application's own `Authorization` and cookies
  pass through untouched.
- **Chromium sandboxing is not a firewall.** Partitions of remote-backend
  previews refuse requests to client-local loopback and private addresses
  (including CGNAT tailnet ranges) other than the service's own ingress, so a
  page cannot silently fall back to a service on the user's machine. This is
  enforced through `webRequest`, not assumed from the sandbox.
- **Services cannot reach each other with the user's session.** On private
  origins, a request carrying one service's preview cookie is forwarded only
  if it comes from that service, from the user, or is a top-level document
  navigation. The desktop tunnel gets the same result from per-service
  partitions and an ingress credential injected only for the service's own
  origin.

### Desktop credential and data path

```mermaid
sequenceDiagram
  participant R as Renderer (ServiceBrowserTab)
  participant M as Electron main
  participant V as Service partition view
  participant I as Local ingress 127.0.0.1:p
  participant G as Backend gateway
  participant A as PreviewAccessService
  participant U as Application
  R->>M: attach {tabId, serviceRef, bounds}
  M->>G: create_preview_attachment (gateway bearer, control API)
  G->>A: mint attachment (service, epoch, generation, surface=desktop-tunnel)
  A-->>M: attachmentId + tunnel credential (only its hash is stored)
  M->>I: listen 127.0.0.1, ingress secret S
  M->>V: load http://127.0.0.1:p/<path> (webRequest adds S for this origin only)
  V->>I: GET /path + S + application Authorization/cookies
  I->>I: verify S, strip S, map Host/Origin to the private authority
  I->>G: WS /__orkestrator/preview/tunnel (offers v2, then v1), once per attachment
  I->>G: HELLO {attachmentId, credential}
  G->>A: authenticate (surface, expiry, revocation, generation)
  G-->>I: READY
  I->>G: OPEN {stream}, once per browser connection
  G->>U: TCP connect to the verified binding for that generation
  G-->>I: OPEN_OK {stream}, then bounded binary frames tagged with the stream, both ways
```

### Connections through the tunnel

Each upstream TCP connection is one stream. On v2, a service's streams share
one outer WebSocket per attachment (up to 32; more open a second session), so
a page's first burst of parallel requests pays one WebSocket handshake and one
HELLO, and each further connection costs one OPEN round trip. A session with
no streams closes after 30 seconds. On v1 each connection is its own
WebSocket. Idle connections are pooled per service on both; nothing is
replayed after a reconnect.

Each stream holds its own admission slot (the "Tunnels" limit below counts
upstream connections on both versions); a v2 session also holds one slot of a
separate session budget with the same limits. Flow control is per stream: each
direction may have 256 KiB sent and not yet credited, and the receiver returns
credit once its consumer has taken the bytes. A stream whose reader stopped
(paused media) therefore stalls at its window without stalling the other
streams on the socket. An `OPEN` refused for capacity fails that stream only.
Revocation, lease expiry and shutdown close the WebSocket and every stream on
it. A new attachment retires the old one's sessions: they take no new streams
and close once their current ones end.

A connection refused with `access-expired` or `generation-changed` is retried
before any application bytes are sent. If a reused replacement is also refused,
one further recovery is allowed; the final open is never retried. One revocation
causes one reattach, however many connections it refused:
`PreviewTransportManager` reattaches only if the attachment the connection was
refused on is still current. If that attachment has been replaced, the
connection retries on the current one with no backend call; if an attach is in
flight, it joins that attach. A reattach releases the attachment it replaces, so
a second one would refuse the connections opening on the first. A renewal refused
after its attachment was replaced follows the same rule.

### Resource ownership

| Resource | Owner | Cleanup |
| --- | --- | --- |
| Definition, endpoint generation, readiness | Backend `PreviewServiceRegistry` | Definitions persist; runtime state is rebuilt on restart under a new epoch |
| Attachment and credential hash | Backend `PreviewAccessService` | Release (by the client, on the issuing backend, including after a connection change or window close), lease expiry, generation change, service removal, credential rotation, kill switch, shutdown |
| Tunnel sockets, streams and upstream TCP | Backend `PreviewTunnelServer` | Closing a stream's upstream releases the stream; closing the socket closes every stream on it; revocation closes everything tracked for the attachment |
| Idle upstream connections (private origins) | Backend `PreviewUpstreamPool`, per attachment | Revocation, expiry or generation change of the attachment, registry revocation of the service, 2 s idle, publication shutdown |
| Local ingress listener and ingress secret | Electron `PreviewTransportManager` | Last attachment release plus a short retirement lease, connection change, window close, app quit |
| Service partition cookies and storage | Electron session | **Reset site data** for that service only; cleared once its service is gone from the backend's list or its connection is forgotten, directory removed on the next start (shared legacy partitions of live connections: see [0042-service-preview-rollout.md](../todo/previews-and-annotations/0042-service-preview-rollout.md)) |
| Browser preview session cookie | Browser holds the value; backend owns validity | Server-side idle and absolute expiry, revocation |

### Copying a browser sign-in

Google refuses OAuth requests from an embedded browser
([policy](https://developers.google.com/identity/protocols/oauth2/policies)),
and a preview view is one, so a sign-in provider is never loaded inside it.
Instead the user signs in with their own browser and copies that session into
the preview. No provider or application setup is needed
(`apps/desktop/electron/preview-session-import.ts`).

1. A main-frame navigation or redirect out of the service is refused as before,
   and the view's state now names the refused host (`blockedNavigation`, the
   host only, never the URL) until the page navigates again. The tab shows it,
   where a page used to appear to hang.
2. **Open in browser** opens the tab's page at `http://localhost:<host port>`,
   the address the provider's registered callback returns to.
3. **Bring sign-in back** (also **Bring sign-in from browser…** in the preview
   options menu), after a confirmation, opens a one-time page in the user's
   default browser. Cookies ignore ports, so that page receives everything the
   browser holds for `localhost` at the requested application path, HttpOnly
   session cookies included. Cookies at other paths require visiting that path in the
   preview and copying again; the confirmation explains this scope.
4. Main stores the cookies in that service's partition and reloads the service's
   views. The outcome is `sessionImport` in the view's state, so a tab unmounted
   meanwhile reads it on return.

The boundaries:

- **Local connections only.** `sessionImport` is absent on a remote connection,
  so this machine's `localhost` cookies never reach another machine.
- **Cookies at the selected path are copied, except Orkestrator's reserved cookies.**
  A browser cannot say which application set a cookie, so the previewed
  application receives the user's other local applications' cookies, as it would
  if the user ran it in that browser. The confirmation says so. **Reset site
  data** removes them.
- **The page is its own credential.** A listener bound to both loopback families
  for one import answers the application path with a random query credential,
  for a top-level navigation addressed to `localhost` that no site started
  (`Sec-Fetch-Site: none`). Anything else is refused without using up the link. The page posts `document.cookie` to the same
  credentialed URL, with an exact Origin check and a bounded body, to distinguish
  readable cookies from HttpOnly cookies. It closes after use, after two minutes,
  on cancel, and when its tab closes.
- **A copy, not a link.** Each cookie stays HttpOnly or JavaScript-readable and
  becomes host-only on `127.0.0.1`, with a one-week lifetime, because a `Cookie`
  header carries no path, expiry, Secure or SameSite attributes. Imported cookies use Path=/ and
  SameSite=Lax. A cookie that needs HTTPS (a `__Host-` name) cannot be stored and
  is counted as skipped. The two sessions are the same session on the server, so
  signing out in either may end both. Cookie values are never echoed in HTML,
  logs or state events; only counts are reported. Reset cancels every service
  view’s pending import, waits for any admitted writes, then clears storage before reloading the views. Dismissal or
  close stops the listener and suppresses late outcomes; a write already admitted
  can finish, and reset waits for it.

The user's default browser is the one consulted, whichever one they signed in
with. Services the browser cannot reach directly (a container service with no
published port) cannot start the sign-in from the tab.

## Operator controls

**Settings → Previews** (`get_preview_settings`/`update_preview_settings`),
stored in the `preview-settings` store:

| Setting | Default | Effect |
| --- | --- | --- |
| `transport` | on | **Kill switch for new access.** Off: no new attachments of any kind; existing access continues until revoked or expired. |
| `relay` | on | Enables the container relay; turning it off stops all relays and re-resolves services |
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
   is issued. Turn the **relay** off with it: compatibility mode needs a host
   port, and a service the relay resolves has none, so its tab has nothing to
   load until it re-resolves as unmapped and offers **Publish port (auto)**.
2. **Revoke all.** Open tunnels close with 4410 and sessions stop working.
3. Service definitions, applications, and layouts are kept. The legacy gateway
   route keeps working for old clients.
4. Turn off publication if needed. This and the relay switch affect only
   Orkestrator's own listener and relay processes, not Tailscale settings.
5. Re-enable when ready. Clients get fresh access to the same `serviceId`.
   Nothing that was in flight is replayed.

`apps/backend/tests/gateway-preview.test.ts` ("rollback drill") runs this
sequence against a real gateway.

**Schema downgrade.** Older clients load saved service tabs
(`orkestrator-preview://service/...` in `browserData.url`). They show
"supports backend-local HTTP addresses" and keep the stored value unchanged.
Preview definitions, settings and identity are database stores; a downgrade
to a build that reads JSON files follows the downgrade note in
[storage](storage.md). Port mappings using Auto (`hostPort: 0`) are rejected
by pre-preview backends' validation. Change them to fixed ports before
downgrading that far.

## Diagnostics

`get_preview_diagnostics` (trusted control API only) returns counts, bounded
failure categories, gauges (tunnel sockets and queued bytes, publication
sockets, relay processes and channels, active admissions), and
p50/p95 connect times. Desktop windows add their own ingress series
(`desktop.connect_ms`, `desktop.first_byte_ms`) and reconnect counts
(`desktop.reconnect{category}`, `desktop.reconnect_failed{category}`), buffered
in Electron and reported every 30 seconds through
`record_preview_client_metrics`. That command accepts only those fixed names,
safe failure categories and bounded numbers, and rejects the whole report
otherwise (`@orkestrator/protocol/preview-client-metrics`). Diagnostics never
contain URLs, paths, queries, headers, credentials, or page contents. Preview credentials cannot call it. A test
("logs, diagnostics, and events never carry credentials…") enforces this.

Readiness in the picker and in environment settings distinguishes these cases:

- the environment is stopped;
- the port is unmapped (the UI offers **Publish port (auto)**, or the relay when
  it is available);
- the connection is refused;
- TLS failed;
- headers timed out;
- the backend is unavailable;
- a local port is served by another environment's process;
- a generated local service is waiting for this environment's server.

Route details name the owner: owned container, started in this environment,
or user-registered (any process listening on the port is shown).

## Limits

Defaults from `PREVIEW_LIMITS` (`packages/protocol/src/preview-services.ts`):

| Resource | Limit |
| --- | --- |
| Service definitions | 32 per environment, 1,024 per backend |
| Tunnels (upstream connections) | 16 per service, 128 per backend, 32 pending handshakes; v2 sessions have the same per-service and per-backend budget, and carry at most 32 streams each |
| HTTP requests (publication) | 32 active per service, 128 per backend |
| Upgrades (publication) | 8 per service, 128 per backend |
| Idle upstream connections (publication) | 8 per access, 64 per backend, 2 s idle |
| Tunnel queues | 256 KiB per direction, 64 MiB aggregate; on v2 also 256 KiB of uncredited data per stream and direction |
| Headers | 32 KiB, 100 fields; 30 s to first response header |
| Idle body | 60 s |
| Upload / download | 128 MiB / 512 MiB per request |
| Grants | 60 s, 8 pending per client and service |
| Sessions | 30 min idle, 8 h absolute |

When a limit is exceeded, the request fails with `capacity-exceeded`: HTTP 503
with `x-orkestrator-preview-error`, or tunnel close code 4429.

A full tunnel queue is backpressure, not a failure. On v2 a stream out of
credit pauses its own upstream the same way, and the shared socket is never
paused, so the backend's pings are always read. When the queue toward the
client reaches 256 KiB, the backend pauses the upstream and returns the rest of
the current read to the upstream's buffer. It resumes once the queue drains,
so the queue never exceeds the limit by more than one frame. Liveness is
any frame from the client within a 30-second interval. A client whose reader
stopped (the browser is not consuming, such as paused media) cannot answer
the backend's ping queued behind the unread data, so the desktop pings the
backend every 15 seconds (`PREVIEW_TUNNEL_CLIENT_PING_MS`) and its tunnel
stays open, holding at most the queue, one read and its admission slot until
the tab closes it. A client that sends nothing for an interval (network
loss, a crashed process) is closed. Older desktops only answer pings, so a
stopped reader on them is still closed after 30 to 60 seconds; older
backends answer the desktop's pings and ignore them. When the backend
itself stops reading (the upstream application is not consuming an upload),
the client's pings wait too, and that tunnel is still closed by liveness.
When a tunnel closes, a slow reader still receives the queued bytes. The
2-second close-handshake grace starts once the close frame has been flushed,
and a peer that stops reading is cut off 30 seconds after the close.
Liveness pings stop once the tunnel starts closing, so an unanswered ping
cannot cut off the drain.

The desktop also acts on missing answers, but only in a v2 session
(`PreviewTunnelSession`): any inbound frame counts as an answer, and a session
that leaves two pings unanswered is destroyed (`terminate`, not a close,
because a dead peer never answers the close frame). A v1 stream
(`PreviewTunnelStream`) has no such deadline: it pauses its socket when its
consumer stops reading, so its pongs can wait behind unread data and a
deadline would close a healthy paused stream. A dead v1 socket costs only its
one stream.

## Framework configuration

Route details → **Framework setup hints** shows the points below for one
service as copyable, version-labelled snippets (Vite, Auth.js v5, NextAuth v4,
Next.js, Express, OAuth providers), with the service's private origin filled
in when it is published (`apps/web/src/lib/preview-framework-hints.ts`). They
are text to copy; Orkestrator never edits the project.

New routes do not rewrite response bodies. Upstream requests carry
`Host: localhost:<application port>` (with default ports omitted). A same-service
`Origin` or `Referer` is mapped to the canonical private origin, normally
`http://localhost:<port>`. Development servers that only accept `localhost` work
unchanged. `X-Forwarded-Proto` always carries the public scheme, including on
writes, fetches, and WebSocket upgrades, so HTTPS-dependent secure-cookie
decisions remain consistent. `X-Forwarded-Host` carries the public host only
when no same-service `Origin` was mapped. On mapped-Origin requests it is
omitted, allowing CSRF checks such as Next.js Server Actions to compare against
the private `Host` instead. Inbound forwarding headers are always discarded.

- **Vite 7.3.6** (pinned fixture): the page, module graph, and HMR updates work
  over a private origin with an empty config. No `allowedHosts` or `hmr`
  settings are needed (`apps/backend/src/preview-vite.test.ts`, opt-in). HMR
  in a real Chromium page is covered by `e2e/preview/private-origin.spec.ts`
  (opt-in Vite fixture); HMR over the desktop tunnel in a real Electron window
  is not yet validated.
- **OAuth**: configure the application with the public service origin
  `https://s-….<domain>` and register its callback URL with the OAuth provider.
  Use that configured origin when generating redirect URIs on writes or
  fetches too. The desktop ingress port can change between sessions, so use
  the published service origin for OAuth flows. In a desktop tab on a local
  connection, sign in with your browser and copy the session instead (see
  [Copying a browser sign-in](#copying-a-browser-sign-in)); no origin is needed.
  Hidden-iframe silent renewal
  that redirects through an external identity provider and back is unsupported:
  even when this service embeds the iframe, the return can carry
  `Sec-Fetch-Site: cross-site` and `Sec-Fetch-Dest: iframe`, so it receives
  `403` before reaching the application and increments
  `http.rejected{forbidden}`. Firefox and WebKit in the test run dropped the
  Lax preview cookie on this return and received `401` before the metadata
  check instead. Use refresh tokens (when supported by the provider), a popup,
  or a top-level redirect flow instead. Direct same-origin
  iframe loads still work. Allowing cross-site iframe returns would also let
  a sibling service launder a frame through an external redirect.
- Applications that build absolute URLs from `Host` produce `localhost` links.
  Set an explicit public origin for URL generation across all request types;
  `X-Forwarded-Host` is absent on mapped-Origin requests, and falling back to
  `Host` there produces private URLs. An application that hardcodes a different
  `localhost` API origin needs that origin configured. Both are configuration
  limitations, not transport bugs.
- **Frontend and API as two services**: a page on one private origin cannot
  fetch, embed or load assets from a sibling service; only links between them
  work. Proxy the API through the frontend's development server (for example
  Vite `server.proxy` to `http://localhost:<api port>`) so the browser sees one
  service.

## Known limitations

- Embedded previews in web and iOS clients are not advertised. They have not
  passed real-browser privacy tests, so those clients open the preview
  top-level.
- Same-service iframe authentication returns through an external identity
  provider are unsupported on private origins; use refresh tokens, popup or
  top-level redirect renewal (see **Framework configuration**). Fetch Metadata
  describes the redirect chain, so the final same-service URL does not make
  the request same-origin.
- Top-level private origins are verified in Playwright Chromium, Firefox and
  WebKit (`e2e/preview/private-origin.spec.ts`). WebKit is engine coverage;
  shipping Safari and iOS are not qualified by it. Firefox/WebKit tests use
  a certificate bypass scoped to throwaway contexts, so they do not prove
  deployment certificate trust.
- The following have not been validated:
  - shipping Safari and iOS devices;
  - Docker Desktop on Windows (Docker Desktop for macOS passed, including
    Auto mappings);
  - a two-machine tailnet run (the real Electron window passed on one
    machine);
  - real private DNS and certificates.
- Private origins add no `Cross-Origin-Opener-Policy`; the application's own
  headers pass through. The web client opens a preview with no opener, but a
  service opened by another site with a plain `window.open` keeps
  `window.opener`. Bootstrap, session and refusal pages send
  `X-Frame-Options: DENY` and `frame-ancestors 'none'`.

  See the evidence log in
  [0042-service-preview-rollout.md](../todo/previews-and-annotations/0042-service-preview-rollout.md).
- Application script on one service host can set a parent-domain cookie for
  its own application cookie names (never the reserved ones). Mutually
  untrusted services need separate preview domains.
- An application service worker can intercept the service host's sign-in path
  and block re-sign-in. The sign-in code only authorizes that same service, so
  nothing leaks, but the user must clear the site's data to recover (observed
  in real Chromium on 2026-10-22). The worker can also carry the code
  elsewhere and redeem it once from another browser, for that same service
  only.
- Cross-service reads are refused by Fetch Metadata, verified in Chromium 156,
  Firefox 157 and Playwright WebKit 27.2. A browser that sends no
  `Sec-Fetch-Site` (Firefox before 90, Safari before 16.4) can still send a blind credentialed `no-cors` `GET` to a
  sibling, and a sibling can still navigate the top-level window to another
  service. A live Tailscale Serve 1.102.4 probe preserved `Sec-Fetch-*` and
  `Sec-Purpose`, including prefetch/prerender; wildcard private DNS,
  certificates and browser traffic through `publicPort` still need deployment
  qualification. If another forwarder strips metadata, reads fall back to
  the `Origin` check. Keep it that way: missing metadata fails open to the
  `Origin` check, never closed, so old browsers and non-browser clients keep
  working. There is no per-deployment opt-out that re-allows
  cookie-authenticated cross-service reads (a frontend and its API published
  as two services, see **Framework configuration**). Add one only if real
  projects report they need it; a `SameSite=Strict` preview cookie is not an
  alternative, because it would also drop the cookie on the last hop of the
  sign-in redirect chain and on every link from another site. Shipping Safari
  and iOS have not been observed sending the metadata.
- The relay needs `node` or `bun` in the image, and the `node` user.
- Local listener attribution needs `ps` and `lsof` (or, on Linux, `ss`) on the
  backend host. Without them every loopback check is `unchecked`, and
  generated local services wait for confirmation. A listener owned by another
  OS user cannot be attributed. Servers started through `orkestrator environment exec` run
  under detached exec workers, which are not managed roots, so they are
  `unattributed` (see **Local environments**). Inside the verification window only the listener's pid is
  rechecked, so a pid reused within those 5 seconds would pass, and a server
  replaced between the lookup and the connect (milliseconds, or the length of a
  lookup already in flight that the connection joined) is not caught until the
  next connection. Each cold connection burst to a `managed-process` target
  costs one `lsof` or `ss`, typically tens of milliseconds.
- Only HTTP/1.1 and WebSockets are carried. HTTP/2-only features, HTTP/3,
  WebTransport, and UDP are not.
