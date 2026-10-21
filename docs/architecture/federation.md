# Federated multi-machine client

Status: Living. The design brief is [`docs/temp/remote.md`](../temp/remote.md).
This file describes what is built. Gaps are listed under
[Known limitations](#known-limitations). Operator setup for SSH is in
[ssh-routes.md](../development/ssh-routes.md). Upgrade, rollback and the
compatibility table are in
[federation-migration.md](../development/federation-migration.md). Synthetic
measurements are in
[federation-benchmarks.md](../development/federation-benchmarks.md).

One desktop window, or one hosted browser page, shows projects and
environments from several independent Orkestrator backends ("machines") at
once. Each environment row starts with a coloured dot naming its machine. A
machine can be reached over HTTPS/Tailscale, over a desktop-managed OpenSSH
tunnel, or both.

## Goals and non-goals

- The client connects to every saved machine directly and independently. A
  slow, offline or incompatible machine never blocks another.
- There is **no central coordinator**. Backends do not know about each other.
  Nothing relays one backend's traffic through another. Nothing schedules,
  places, migrates or replicates work across machines. The per-project
  Coordinator agents are unchanged and stay inside their own backend.
- The client aggregates views. Each backend stays authoritative for its
  projects, environments, agents, workflows, approvals, files and Git.
  Hiding a machine, changing the filter, closing a panel or forgetting a
  machine never stops remote work.
- SSH carries the existing authenticated client API. It is not a second
  execution path, and gateway authentication still applies on top of it.

## Ownership

| Concern | Owner | Client role |
| --- | --- | --- |
| Projects, environments, agents, workflows, approvals, files | Owning backend | Render summaries; send explicit commands to the owner |
| Machine name, colour token, profile revision | That backend (`backend-profile` store) | Cache and display; edit with compare-and-swap |
| Saved machines, routes, SSH settings, encrypted tokens | Client device (desktop native catalogue, or browser storage) | The renderer sees safe summaries only |
| SSH processes, host-key trust, prompts | Desktop main process (`apps/desktop/electron/ssh/`) | React never spawns SSH or builds argv |
| Machine filter, grouping, outer panel layout | Client presentation (`machineViewStore`) | Persisted locally, by connection ID |
| Environment-local tabs and layouts | Owning backend (unchanged) | Rendered inside that machine's realm |

## Components

| Layer | Module | Responsibility |
| --- | --- | --- |
| Protocol | `packages/protocol/src/federation.ts` | `BackendId`, `RouteId`, composite refs, structured keys, resource links |
| Protocol | `packages/protocol/src/backend-profile.ts` | Profile, palette, default colour, hello contract and parser |
| Protocol | `packages/protocol/src/device-catalogue.ts` | Catalogue v2 schema, validators, v1 migration, v1 down-projection |
| Protocol | `packages/protocol/src/connections.ts` | Renderer-safe `ConnectionSummary` fields, transport/identity vocabulary |
| Backend | `apps/backend/src/gateway-auth.ts`, `gateway-lifecycle.ts` | `GET /__orkestrator/hello`, loopback client listener |
| Backend | `core/storage-preview-services.ts`, `core/commands-registry-backend-profile.ts` | Profile store and commands |
| Desktop | `electron/connection-manager.ts` (+ `connection-*.ts`, `backend-hello.ts`) | Catalogue, bindings, observations, routes, handover |
| Desktop | `electron/connection-catalogue-store.ts` | Native catalogue file, backup, v1 snapshot |
| Desktop | `electron/ssh/*` | OpenSSH tunnel supervisor |
| Desktop | `electron/federation-ipc.ts`, `ssh-prompt-broker.ts`, `backend-panel-views.ts` | IPC, askpass prompts, machine panel views |
| Renderer | `apps/web/src/lib/federation/*` | Backend clients, registry, runtimes, aggregation, recovery |
| Renderer | `apps/web/src/components/federation/*` | Provider, filter, dots, rows, sections, panels, effects |
| Renderer | `apps/web/src/components/settings/connections/*` | Machine details, SSH dialog, feature toggles, browser machines |

`.oxlintrc.json` forbids `@/lib/native/backend`, `@/lib/backend` and
`@/lib/backend/*` imports under `apps/web/src/lib/federation/**` and
`apps/web/src/components/federation/**`. Federated code reaches a machine only
through a backend-bound client.

## Identities

| Identity | Source | Lifetime | Used for |
| --- | --- | --- | --- |
| **Backend ID** | `installationId` from the hello. It is the `instanceId` of the backend's `backend-identity` store, the same value as `installationId` in `backend-instance.json`. | One installation and data directory | Machine identity, route merging, storage namespaces, `ProjectRef`/`EnvironmentRef` |
| **Generation** | Hello `generation` (the storage resource generation) | One backend process | Deciding whether an event-stream replay cursor survives a route change |
| **Route ID** | `https-…` / `ssh-…` (`connection-records.ts`); migrated routes are `https-<v1 id>` | One saved route | Route order, quarantine, session tokens, tunnel leases |
| **Connection epoch** | Desktop: `ConnectionManager.nextEpoch` (Local is always `0`). Browser: incremented per event-stream reconnect. | Client process | Fencing late reads and events after a reconnect, retarget or token change |

A machine with no verified identity gets `provisional:<catalogue entry id>`
(`provisionalBackendId`). Provisional entries are never merged and never fail
over to another route. An address, host name, display name, colour or
forwarded port is never an identity.

Keys are structured JSON, never delimiter-joined: `environmentKey(ref)` is
`["<backendId>","environment","<id>"]`. React keys, aggregation, attention
toasts and links all use these keys. The wire protocol to one backend still
carries ordinary local IDs. The client picks the connection first.

## Hello handshake

`GET /__orkestrator/hello` (`BACKEND_HELLO_PATH`) sits behind normal gateway
authentication on every listener. A missing token gets `401`; any method other
than GET gets `405`. The response (`parseBackendHello`) contains:

- `schemaVersion: 1`, `installationId`, `generation`, `appVersion`
- `clientApi: { minVersion, maxVersion }`. The client requires
  `CLIENT_API_VERSION` (1) to fall inside that range.
- `capabilities`: name to version, at most 64 entries. The backend sends
  `backend-profile` and `summary-reads`, and also `loopback-client-gateway`
  while that listener is serving.
- `profile`: the canonical machine profile.
- `endpointRole`: `control` on the loopback control listener, otherwise
  `client`.
- `authorizationScopeId`: defined in the contract but never sent today.

The hello never includes data paths, the auth-file path, the token or the
process ID. It is served with `cache-control: no-store`.

`checkBackendRoute` (`apps/desktop/electron/backend-hello.ts`) runs the
handshake before a route is used:

- Redirects are refused. A 3xx response is a `protocol` error, so a token
  never follows a redirect.
- Any other answer means an older backend: a `404`, a body over 64 KiB, or a
  200 that does not parse as a hello. The client then calls the authenticated
  `/__orkestrator/status`.
  If that succeeds, the outcome is `legacy`: the identity stays provisional,
  routes are never merged and fallback is off.
- A `401` maps to `authentication-required`, an incompatible API range to
  `incompatible`, and a timeout or network failure to retryable
  `timeout`/`unreachable`.
- SSH routes also require a real hello whose `endpointRole` is `client`
  (`assertSshOutcome`). A legacy backend gives `legacy-backend`. A control
  listener gives `control-endpoint`, and that route is quarantined.

## Machine profile

- Stored in the backend's `backend-profile` document store
  (`StoragePreviewServices.getBackendProfile`) as `{ version: 1, revision,
  displayName, colorToken, updatedAt }`.
- It is created once, on first read, under a storage lease. The name is the
  host name without `.local`, or `Orkestrator` if that is empty. The colour is
  `defaultMachineColor(installationId)`: FNV-1a over the ID, modulo the
  palette. An unreadable record is replaced with a revision above the old one,
  so stale edits still conflict.
- Palette tokens (`MACHINE_COLOR_TOKENS`): `violet`, `blue`, `teal`, `green`,
  `amber`, `orange`, `rose`, `slate`. The backend stores the token, never CSS.
  `apps/web/src/lib/federation/machine-colors.ts` maps tokens to theme
  classes. A token this client does not know renders as `neutral` (dashed
  outline, "Unknown colour"). The stored token is never rewritten.
- `get_backend_profile` takes no arguments.
  `update_backend_profile { expectedRevision, displayName?, colorToken? }` is
  compare-and-swap. A stale revision fails with `backend-profile-conflict: …`
  and writes nothing. On success the revision goes up by one and the backend
  emits `backend-profile-changed` with the new profile.
- The desktop applies profile events whose revision is not older than the
  cached one, and writes `profileCache` into the catalogue. That cache labels
  an offline machine (`profile.cached: true`). Each renderer runtime also
  applies that machine's profile events (newer revisions only). Connections
  edits send the newest revision the client has seen. The Connections page warns
  about colour collisions (`duplicateMachineColors`) but never recolours a
  machine. On a profile conflict it shows the current values and does not
  retry.
- Names are normalized: control and bidi characters removed, whitespace
  collapsed, at most 64 characters. A device nickname is a separate local
  alias, shown as "(on this device)", and takes precedence for display.
- Without a profile, a verified ID falls back to `defaultMachineColor`. An
  unverified machine renders `neutral`.

## Device catalogue (version 2)

The desktop keeps the catalogue in its own data directory, not in the local
backend. It stays readable and writable while Local is stopped or crashed.

| File (under `<userData>/connections/`) | Purpose |
| --- | --- |
| `device-connections.json` | The catalogue: `{ version: 2, activeConnectionId, backends[], features, migratedFromVersion?, migratedAt? }` |
| `device-connections.backup.json` | Previous good primary, copied before each save. Used when the primary does not parse. |
| `device-connections.v1-snapshot.json` | The version-1 list as it was at migration. Written once (`wx`, mode 0600). |

- Writes are serialized. Each save writes a unique temporary file (`wx`,
  0600), fsyncs it and renames it over the primary. The directory is 0700. The
  catalogue is limited to 1 MiB.
- Each `SavedBackend` has: `id`, `verifiedInstallationId?`, `localAlias?`,
  `fallbackName`, `routeOrder`, `routes`, `autoConnect`, `lastConnectedAt?`,
  `profileCache?` and `provisionalColor?`. Each route has `id`, `enabled`,
  `encryptedToken` (an OS `safeStorage` blob in base64, or `""` when the token
  is held for this session only) and `lastConnectedAt?`, plus either an HTTPS
  `origin` or the SSH fields `destination`, `sshPort?`, `identityFile?` and
  `remoteGatewayPort`.
- Limits: 64 machines, 1–8 routes per machine. Route IDs must be unique, and
  `routeOrder` is repaired to list every route exactly once.
- Validation: HTTPS origins only (HTTP only for loopback), with no
  credentials, path, query or fragment. SSH destinations are checked by
  `validateSshDestination`, ports must be 1–65535, and an identity file must
  be an absolute or `~/` path to a key file, never key material.
- Migration from v1 and the downgrade path are described in
  [federation-migration.md](../development/federation-migration.md).
- The hosted browser has no catalogue file. Other machines are kept in
  `localStorage` `orkestrator.federation.machines` (origin and nickname, at
  most 16). Their tokens stay in `sessionStorage`
  `orkestrator.federation.tokens`.

## ConnectionManager (desktop main process)

### Bind and observe

- **Bind**: every window scope is bound to one machine. Its legacy
  single-backend renderer, title, previews and request authorization all use
  that machine (`bind`, `use`, `release`). The `default` scope follows
  `activeConnectionId`. A panel is its own scope, `panel:<uuid>`.
- **Observe**: a window can also hold reference-counted leases on any number
  of other machines (`observe`/`unobserve`, at most 64 per scope). Observing
  connects the machine in the background. `invokeOn(scope, connectionId, …)`
  accepts only a machine the scope is bound to or observes. There is no
  fallback to Local or to the first entry. A connection with no bindings and
  no observers is torn down (`releaseIfUnused`).

### Queues and locks

- Each scope has its own queue (`enqueueScope`), so one window's connect never
  waits for another's. Scope generations reject work from a window that has
  closed or rebound.
- Catalogue writes take a short separate lock (`enqueueCatalogue`). It is
  never held while dialling, prompting or waiting for a timeout. A failed save
  leaves memory unchanged.

### Background connections and reconnect

- Background activation is coalesced to one attempt per machine. At most
  **4** background attempts run at once across all machines
  (`MAX_BACKGROUND_ATTEMPTS`). User-initiated connects do not take a slot.
- Background attempts are non-interactive: SSH runs with `BatchMode=yes` and
  never prompts.
- Retryable failures are rescheduled while the machine is still wanted, with
  delays of 1, 2, 5, 10, 30 and then 60 s (`DEFAULT_RECONNECT_DELAYS_MS`).
  Credential, trust and compatibility failures are not retried.
- Timeouts: 10 s per connection check, 3 s for `probe`, 3 s for the local
  hello.

### Route selection (`connection-route-selection.ts`)

1. The candidates are enabled routes of a kind this client supports, in user
   order, minus quarantined routes. The current route is tried first on a
   reconnect.
2. Each candidate opens its transport. SSH acquires a tunnel lease. Then the
   hello runs. A route is usable only after an authenticated hello, or a
   legacy status check for HTTPS.
3. A hello whose `installationId` differs from `verifiedInstallationId` is
   `identity-mismatch`. That is a trust failure: the route is quarantined with
   a reason (`blockedRoutes`) and selection stops. A fallback route that
   cannot prove identity is treated the same way.
4. **Fallback** to a later route happens only when all of these hold:
   `routeFallback` is on, the machine is verified and not in `conflict`, and
   the failure is retryable. Grant equivalence is **the same gateway token
   string** as the first route. A route holding a different token is skipped
   and needs an explicit **Use** (`useRoute`). If the first route has no token,
   selection stops.
5. Trust failures (`host-key-unknown`, `host-key-changed`,
   `identity-mismatch`, `control-endpoint`) quarantine the route. Credential
   failures become `authentication-required`. Unsupported configurations
   become `incompatible`. None of these are hidden by trying another route.
   `useRoute` clears the quarantine and retries interactively.

`connect` (HTTPS) and `connectSsh` add routes. A route that proves an
installation already verified on this device joins that machine. "Add
connection method" (`connectionId`) requires the machine to be verified
already, and the new route must prove the same installation. If two saved
entries prove one identity, both show `identity: "conflict"` and fallback is
disabled. Removing a route is refused for a machine's last route. Use Forget
for that. Changing the route order never moves a healthy active route.

### Handover and epochs

A handover happens when a tunnel closes, a route is disabled or removed, SSH
routes are turned off, a retry fires, or three consecutive event-stream drops
occur while an alternative route exists and fallback is on. It:

- increments the machine's epoch at once and re-establishes the route,
  current route first;
- makes commands issued meanwhile wait (`invokeRemote` awaits
  `remote.handover`), so there is one mutation destination at a time;
- calls `BackendHttpClient.retarget(baseUrl, token, { preserveCursor })`
  instead of creating a new client. The terminal input sequencer and its
  ambiguous-send fence therefore survive the route change. The SSE replay
  cursor is kept only when the new hello reports the same generation;
- never resubmits a write. An in-flight read may be abandoned.

A token change (`updateToken`, `setGatewayToken`) also retargets and bumps
the epoch.

### Events

Remote events go to:

- windows and panels bound to the machine, over the existing
  `orkestrator:event` channel;
- observing windows, over `orkestrator:backend-event` with
  `(connectionId, epoch, event, payload)`.

The envelope comes from the receiving connection, never from the payload.

### Local backend unavailable

If Local fails to start and a native catalogue with saved machines exists, the
desktop starts anyway. `createUnavailableLocalBackend` rejects every Local call
with a plain message, and remote machines work normally. With no saved
machines, startup fails as before. An unexpected Local exit marks Local
unavailable and leaves remote windows connected.

## Renderer runtime (`apps/web/src/lib/federation`)

### Backend clients

`BackendClient` has `connectionId`, `invoke`, `subscribe(listener(event,
payload, epoch))`, `observe` and `release`. There are two implementations:

- `createDesktopBackendClient` uses the `window.orkestrator.backends` IPC.
  One dispatcher fans out events by the connection they arrived on.
  `observe`/`release` map to native leases.
- `createHttpBackendClient` (hosted browser) makes direct HTTPS calls to
  `/__orkestrator/invoke` and `/__orkestrator/events`. It uses a bearer token,
  `credentials: "omit"`, `mode: "cors"` and `redirect: "error"`, and excludes
  terminal output from the stream. Responses are limited to 32 MiB. It reports
  `open`/`closed`/`unauthorized`.

### Registry and the bound machine

`FederationProvider` creates one `BackendClientRegistry`. On desktop it is fed
by the connection list. In a hosted browser it is fed by `browserFederationList`.
On iOS WKWebView and inside a panel realm, `kind` is `none`.

`registry.sync` creates one `BackendRuntime`, holding summary demand, for
**every machine except the one this realm is bound to**. The bound machine
keeps its existing full single-backend stores, and `useBoundMachineView`
projects them. It is never read twice. `registry.require(backendId)` throws
when the machine is not connected. Runtimes are disposed when a machine is
forgotten or federation is turned off, not when a component unmounts.

### BackendRuntime

- **State**: one zustand vanilla store per machine
  (`MachineSummaryState`: `backendId`, `connection`, `freshness`, `projects`,
  `environmentsByProject`, `truncated`, `epoch`, `lastError`). The runtime
  also owns its own `PrefetchedCommandCache`, so identical reads on two
  machines never share an answer, and its own `OperationRecovery`.
- **Hydration** (`hydrate`): calls `get_projects` (first 500,
  `MAX_SUMMARY_PROJECTS`), then `get_environment_snapshots` per project (first
  500 each, `MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT`). At most 4 reads run at
  once (`SUMMARY_READ_CONCURRENCY`). One hydration runs at a time, with at
  most one queued rerun. Records past a cap set `truncated`, and the sidebar
  says so. Summaries never fetch transcripts.
- **Epoch fencing**: a result applies only if the epoch and backend ID it
  started under are still current. An event with a new epoch updates the
  epoch, marks the machine `catching-up` and rehydrates. That event is not
  applied.
- **Revision gaps**: `resource-changed` revisions are compared only within
  this machine. A repeat or a skip rehydrates **this machine only**.
  Environment changes are coalesced per project (250 ms). Project changes and
  `native-event-stream-connected` trigger a full rehydrate.
- **Identity change** (provisional to verified): summaries and cache are reset
  and reloaded under the proved ID.
- **Credential or trust failure** (`authentication-required`,
  `trust-blocked`): cache and summaries are purged and `freshness` becomes
  `stale`. This is not shown as a normal offline state. A plain disconnect
  keeps the last-known summaries, labelled stale.
- **Writes** (`mutate`) clear the runtime's prefetch cache and go through
  `OperationRecovery`. Writes are allowed only while
  `isMachineWritable` (bound machine, or transport `connected`). There is no
  offline queue.

### Outcome unknown

`OperationRecovery.run` turns an ambiguous failure into an `UnknownOutcome`
record: a `TypeError`, or a message matching
network/socket/abort/timeout/reset. The record holds `backendId`, `command`,
`label`, `requestKey?` and a content-free FNV fingerprint of the input, never
the arguments. At most 50 are kept. The write is **never resent**.
`UnknownOutcomesNotice` shows the records under their own machine's section
until the user dismisses them. This covers federated runtime writes: sidebar
start, stop, delete and create, and profile edits on other machines. Inside a
panel or the bound window, the existing single-backend paths and their own
recovery apply.

### Captured-owner actions

`federated-actions.ts` takes the concrete `EnvironmentRef`/`ProjectRef` it was
started with. A delete confirmation names the machine and keeps the captured
ref, so later focus or filter changes cannot retarget it. Creating an
environment inside a project instance targets that project's machine. There is
no placement. Dragging a federated row is refused with an explanation, and
nothing moves between machines.

## Machine panels: one realm per machine

A **machine panel** shows one workspace of another machine beside the window's
own workspace. The outer layout (`machineViewStore.panels`, at most 4, oldest
closed first) is client-local.

- **Desktop**: `BackendPanelViews` creates a child `WebContentsView` with the
  standard preload, `contextIsolation`, no node integration, and the renderer
  URL with `?panel=workspace&project=…&environment=…`. Each panel:
  - binds its own connection scope `panel:<uuid>`;
  - uses its own session partition per machine,
    `persist:orkestrator-panel-<sha256(connectionId)[:16]>`;
  - installs its own request-auth hook for that scope, plus navigation guards
    and a deny-all window-open handler.

  The parent sends only bounds (scaled by zoom), visibility and close. The
  native view is hidden while a dialog or menu of the parent is open. A window
  has at most 4 panels. A panel cannot switch machines. Closing a panel, or its
  parent, releases only that scope.
- **Hosted browser**: a same-origin `<iframe>` of the app with
  `?panel=workspace&machine=<id>&…`. `web-gateway.ts` installs the frame's
  gateway API with that machine's origin and this tab's session token, so the
  frame talks to that machine directly and nothing goes through the page's
  backend. On a phone-sized viewport the same URL opens in a new tab instead
  of a side panel.
- Inside a panel realm, `AppShell` renders only the action bar and workspace:
  no sidebar, no nested panels, no federation.

**Why realms.** The workspace UI is built on many module-level singleton
stores and services: project, environment, UI, terminal, file, session and
pane stores, the prefetch cache, gateway URL resolution and the event
transport. Each assumes one backend. Re-keying every one of them for two
machines in one React tree would be a rewrite with a large leakage surface.
A separate realm per machine gives each panel its own copies of all of them.
Isolation comes from the realm boundary and a scope bound to one machine, not
from careful keying.

**Deviation from the plan.** Section 07 of the plan says "two such scopes must
coexist in the same React render tree". That is **not** what was built. Two
machines' detail UIs never share a render tree. The main window's tree holds
only summary runtimes for other machines (the sidebar). Full workspaces of
other machines run in their own realms. The trade-off: a panel costs a
renderer process (desktop) or a frame, and some desktop-only features are not
wired into panel views (see Known limitations).

## Sidebar presentation

When federation is enabled and at least one other machine is saved,
`HierarchicalSidebar` replaces the switch-and-reload `ServerConnectionSwitcher`
with `MachinesFilter`:

- The filter offers **All machines** (the default), each machine, and
  **Manage connections…**. It also shows connected/total (`2/3`) and a label
  such as `2 connected · 1 unavailable`. It never says "all caught up" while a
  machine is missing (`connectivitySummary`).
- Changing the filter is presentation only. It never closes a transport or
  changes a panel's owner.
- Grouping options are **By machine** (the bound machine's full tree, then
  `RemoteMachineSection` per other machine, in that backend's order), **By
  project** (instances with machine badges; equal names stay separate) and
  **By repository**. The activity sort gives one attention-first list. The
  projections live in `aggregate.ts` and never merge records.
- Repository grouping uses only a sanitized `host/owner/name` hint derived
  from the project's Git URL (`repositoryHint`), or an explicit mapping
  argument. Names, paths and branches never group projects.
- Activity order: unread first, then waiting, working, idle, then the
  backend-reported timestamp. The final tie-breakers are backend ID and
  environment ID. Timestamps come from different clocks, so this is a
  presentation sort only.
- `MachineDot` sits immediately before every environment name: federated rows
  and the bound machine's `EnvironmentItem`. It is 8 px with an outline and
  never shows activity or health. An unavailable machine's rows are dimmed
  and read "Connection lost; last observed …", never "stopped". The dot is
  decorative when the label names the machine, and an image otherwise. In
  forced-colours mode it keeps an outline and compact badges show the name.
  "Compact machine labels" reduces labels to the dot plus a tooltip.
- A row of the bound machine selects in place. A row of another machine opens
  its panel. Its actions menu offers Open in panel, Copy link, Start, Stop and
  Delete…, all disabled while the machine is not writable.
- `FederationEffects` handles `?resource=<encoded {b, e|p}>` links
  (`encodeResourceLink`). The link names a machine and a resource, never a
  route, port or token. A link for an unsaved machine offers to add a
  connection instead of resolving against this window. The same component
  shows attention toasts ("Waiting for input", "New completed work") for
  other machines, deduplicated by machine-qualified key.
- The project search dialog adds an "Other machines" section
  (`FederatedSearchSection`, at most 20 rows). It is labelled per machine,
  opens that machine's panel, and says when results may be incomplete
  because a machine is unavailable, still loading or truncated.
- Settings pages show a scope banner: **This client** for Connections,
  **Backend: name** for everything else, which always targets the window's
  bound machine.

## Storage namespacing

`desktopConnectionStorageKey` (`apps/web/src/lib/desktop-storage-key.ts`)
applies in Electron renderers (`isolatedViewState`). The namespace comes from
`window.orkestratorDesktopIdentity`, which the preload reads by synchronous
IPC at page load:

- Local uses `local`.
- A verified machine uses `backend:<installationId>`.
- An unverified HTTPS machine keeps its legacy origin-derived namespace.
- An unverified SSH-only machine uses `connection:<id>`.

A tunnel's ephemeral port never forms part of a key. The first time a machine
is verified, its new key adopts the old origin-derived value, once, if the new
key is empty. `getGatewayBaseUrl` asks the native layer on every call
(`resolveBaseUrl`), because a tunnel can move to another local port after a
reconnect.

## Security invariants

- Every route ends with gateway authentication. SSH login never replaces the
  token (SH-08). The loopback client listener answers `404` for control-only
  routes, and SSH refuses an `endpointRole: "control"` forward (SH-09).
- Host keys are checked with `StrictHostKeyChecking=yes`. A first-use key
  needs explicit approval of a probed fingerprint. A changed key is blocked.
  Identity mismatches are quarantined and nothing is merged.
- Federation IPC rejects senders that are not the trusted renderer URL. The
  renderer supplies only connection IDs, route IDs, a command name of at most
  128 characters, and validated SSH fields. It never supplies a URL, a
  credential or an argv. SSH runs from an argv array with `--` before the
  destination, `shell: false` and no remote command.
- The bearer is injected only for the exact current origin of the scope's
  bound machine, and only under `/__orkestrator/`
  (`getRendererRequestAuthorization`). Each panel has its own hook and scope.
  Two tunnels on the same loopback host differ by port and never share a
  credential.
- Backend-sourced strings (names, summaries, diagnostics) are bounded and
  stripped of control characters, then rendered as text. Diagnostics redact
  home paths, bearer tokens, users, quoted values and paths. Raw OpenSSH
  stderr stays inside the adapter. Askpass answers are never logged or stored.
- Tokens stay in OS `safeStorage`. When that is unavailable (or Linux
  `basic_text`) they are kept for the session only. The renderer never
  receives a token in a summary.
- Forget is local only. It does not revoke the device, stop the backend or
  delete remote data.

## State vocabulary

Three dimensions are kept separate:

| Dimension | Values | Authority |
| --- | --- | --- |
| Transport (`ConnectionTransportState`) | `disabled`, `connecting`, `authenticating`, `connected`, `reconnecting`, `authentication-required`, `trust-blocked`, `incompatible`, `unreachable` | Client connection layer |
| Identity (`ConnectionIdentityState`) | `verified`, `provisional`, `conflict` | Client, from hellos |
| Freshness (`SummaryFreshness`) | `initializing`, `current`, `catching-up`, `stale`, `degraded` | Per-machine runtime |
| Activity | `idle`, `working`, `waiting` (backend `agentActivityState`), shown as last-observed while disconnected | Owning backend |

`machineStatusText` shows these as Connected, Catching up, Connecting,
Reconnecting, Sign-in needed, Blocked: verify this machine, Not supported by
this client, Not connected, or Unavailable · last seen ….

## Feature flags

The flags live in the catalogue's `features` and are edited under Settings →
Connections (`setFeatures`). Each defaults to `true`. Turning one off stops
client machinery only, never remote work.

| Flag | Off means |
| --- | --- |
| `federation` | All observations end and `observe` is refused. Renderer runtimes are disposed. The sidebar returns to the single-machine switcher. Window bindings are untouched. |
| `sshRoutes` | SSH is removed from `supportedRouteKinds`. Live SSH connections hand over, or fail if the machine has no HTTPS route. `connectSsh` and host-key probes are refused. |
| `routeFallback` | Only the preferred or current route is tried. Repeated stream drops never switch routes. |

The hosted browser reports `federation: true, sshRoutes: false,
routeFallback: false` and has no toggles.

## Known limitations

These are plan items that are not implemented, or are only partly
implemented.

- **No shared client-runtime package.** The runtime lives in
  `apps/web/src/lib/federation` and is not used by iOS. The bound machine
  still uses the legacy singleton stores (`projectStore`, `environmentStore`
  and others). Isolation between machines comes from realms, not from
  runtime-scoped store factories.
- **Desktop machine panels** have no native browser previews and no live
  artifact hosts (`browserPreviewManager` and `artifactHosts` are `null` for
  panel senders). A panel cannot switch machines. Turning `federation` off
  removes other machines' views, so open panels show "not saved on this
  device" and close their native views.
- **Hosted-browser panels** are same-origin frames. They share the page's
  `localStorage` keys, because per-machine namespacing applies only in
  Electron. Tokens for other machines last for the tab session only. The
  other backend must allow the page's origin (`--allowed-origins`).
- **Mobile**: iOS WKWebView stays single-machine (`kind: "none"`). There is
  no mobile SSH, and background/resume (MB-01) is not addressed.
- **SSH**: macOS and Linux desktop only. Windows is not qualified. There is no
  SSH in browsers. Nothing installs or starts a remote backend, and there is
  no SSH pairing for the gateway token. There is no ControlMaster
  multiplexing. No UI removes or rotates a trusted host key: changed-key
  recovery is manual (see [ssh-routes.md](../development/ssh-routes.md)).
  Askpass prompts go to the focused main window.
- **Grants**: the hello never sends `authorizationScopeId`. Grant
  equivalence is identical token strings, so routes with different tokens
  never fall back automatically.
- **Identity conflicts** are shown as a status and message only. There is no
  merge or re-pair UI. Resolve one by forgetting one of the entries. The hello
  is trusted as reported. A second installation with a copied ID, added with
  **Add machine**, joins the first machine as another route instead of
  raising a conflict (plan ID-04 is met only for two existing entries).
  Fallback between such routes still needs an identical token.
- **`autoConnect`** is persisted and settable over IPC, but no UI sets it,
  the summary does not expose it, and nothing reads it. While federation is
  on, every saved machine is observed.
- **`provisionalColor`** exists in the schema but is never written.
  Unverified machines without a profile render the neutral colour.
- **Summaries** are capped at 500 projects and 500 environments per project,
  with a truncation notice and no pagination. The plan's per-environment
  detail demand (`acquireEnvironmentDemand`) does not exist; detail comes only
  from panels. Last-known summaries are kept in memory only, so after a
  restart an unreachable machine shows just its cached name and colour.
- **Global creation**: the sidebar's **Add project** still targets the
  window's bound machine, with no machine selector. Per-project **New
  environment** on other machines targets its owner correctly. Settings for
  another machine are edited inside its panel.
- **Repository grouping**: there is no UI for explicit user mappings, and the
  backend publishes no repository hint. The hint is derived by the client from
  `gitUrl`.
- **Revocation**: there is no "revoke this device" action and no revocation
  signal from the backend. Summaries are purged only when the transport
  becomes `authentication-required` or `trust-blocked`.
- **Deep links** are a page query parameter only. Desktop has no OS URL
  handler, and Copy link exists only on other machines' rows. Attention
  notices are in-app toasts, not OS notifications.
- **Route policy**: there is no "prefer fastest" mode (optional in the plan).
- **Performance**: only a synthetic in-process benchmark exists
  ([federation-benchmarks.md](../development/federation-benchmarks.md)). The
  plan's real-backend matrix, p95 approval and completion visibility, bytes per
  minute, and multi-client runs are not measured.
- **Migration edges**: see
  [federation-migration.md](../development/federation-migration.md). These
  include first launch with Local failing, and a frozen v1 list after
  downgrade.

## Acceptance-ID map

Test names carry the plan's scenario IDs (section 22). Paths are relative to
the repository root.

| ID | Tests |
| --- | --- |
| ID-01 | `packages/protocol/src/federation.test.ts`, `apps/web/src/lib/federation/federation-runtime.test.ts` |
| ID-02, ID-03, ID-04 | `apps/desktop/tests/connection-manager-federation.test.ts` |
| RT-01 | `apps/desktop/tests/connection-manager-federation.test.ts` (also the benchmark) |
| RT-02 | `apps/web/src/lib/federation/federation-runtime.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| RT-03 | `apps/desktop/tests/connection-manager-federation.test.ts`, `apps/web/src/lib/federation/federation-runtime.test.ts` |
| RT-04, RT-05, RT-06 | `apps/web/src/lib/federation/federation-runtime.test.ts` |
| OP-02 | `apps/web/src/lib/federation/federation-runtime.test.ts` |
| OP-05 | `apps/web/src/lib/federation/federation-runtime.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| OP-06 | `apps/desktop/tests/connection-manager-federation.test.ts`, `apps/desktop/tests/federation-ipc.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| UI-01 | `apps/web/src/lib/federation/aggregate.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| UI-02 | `apps/web/src/lib/federation/aggregate.test.ts` |
| UI-04 | `apps/web/src/lib/federation/federation-runtime.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| CL-01 | `apps/desktop/tests/connection-manager-federation.test.ts` |
| CL-02 | `apps/desktop/tests/connection-manager-federation.test.ts`, `apps/web/src/lib/desktop-storage-key.test.ts` |
| CL-03 | `apps/web/src/lib/federation/aggregate.test.ts` |
| CL-04 | `apps/backend/src/core/backend-profile-store.test.ts`, `apps/web/src/components/settings/connections/connections-machine.test.tsx` |
| CL-05 | `apps/web/src/components/federation/federation-ui.test.tsx` |
| SH-01 | `apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts`, `packages/protocol/src/device-catalogue.test.ts` |
| SH-02 | `apps/desktop/tests/ssh/host-trust.test.ts`, `apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts`, `apps/web/src/components/settings/connections/connections-machine.test.tsx` |
| SH-03 | `apps/desktop/tests/ssh/tunnel-supervisor.test.ts`, `apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts`, `apps/desktop/tests/federation-ipc.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| SH-05, SH-07 | `apps/desktop/tests/ssh/tunnel-supervisor.test.ts`, `apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts` |
| SH-06 | `apps/desktop/tests/ssh/stderr-classification.test.ts`, `apps/desktop/tests/ssh/tunnel-supervisor.test.ts`, `apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts` |
| SH-08, SH-09 | `apps/backend/tests/gateway-hello.test.ts`, `apps/desktop/tests/connection-manager-federation.test.ts` |
| SH-10 | `apps/desktop/tests/ssh/tunnel-supervisor.test.ts`, `apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts`, `apps/desktop/tests/connection-manager-federation.test.ts` |
| SH-11 | `apps/desktop/tests/ssh/tunnel-supervisor.test.ts`, `apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts` |
| SH-12 | `packages/protocol/src/device-catalogue.test.ts`, `apps/desktop/tests/ssh/ssh-command.test.ts`, `apps/desktop/tests/ssh/tunnel-supervisor.test.ts`, `apps/desktop/tests/connection-manager-federation.test.ts` |
| SH-13 | `apps/desktop/tests/ssh/ssh-command.test.ts`, `apps/desktop/tests/ssh/tunnel-supervisor.test.ts` |
| AU-01, AU-02 | `apps/desktop/tests/connection-manager-federation.test.ts` |
| AU-03 | `apps/web/src/lib/federation/federation-runtime.test.ts` |
| WB-02 | `apps/desktop/tests/connection-manager-federation.test.ts` (desktop analogue: a client without SSH) |
| MG-01 | `packages/protocol/src/device-catalogue.test.ts`, `apps/desktop/tests/connection-manager-federation.test.ts`, `apps/web/src/lib/desktop-storage-key.test.ts` |
| MG-02, MG-04 | `apps/desktop/tests/connection-manager-federation.test.ts` |
| PF-01, PF-02, PF-03 | `apps/web/src/lib/federation/federation-runtime.test.ts` |

The test labelled `OP-04/UnknownOutcomesNotice` in `federation-ui.test.tsx`
covers outcome-unknown display. It does not cover the plan's OP-04, two
clients answering one approval.

No test names these IDs: ID-05, RT-07, OP-01, OP-03, OP-04 (as defined in
the plan), UI-03, UI-05, UI-06, FS-01, FS-02, CT-01, CT-02, CT-03, WB-01,
MB-01, MG-03, SH-04 (ProxyJump) and SH-14 (external ControlMaster). The
SH-14 behaviour (`ControlMaster=no`, `ControlPath=none`) is fixed by
`buildTunnelArgs` and checked only by argv assertions in `ssh-command.test.ts`.
ProxyJump detection is unit-tested (`parseSshConfigOutput`), but no jump-host
connection is exercised. Real-sshd cases run
only with `ORKESTRATOR_SSH_INTEGRATION=1`; see
[ssh-routes.md](../development/ssh-routes.md#real-sshd-integration-test).
