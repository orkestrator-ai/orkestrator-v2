# Federated multi-machine client

Status: **Living, for the client side of multi-machine Orkestrator.** The
multi-machine architecture is [command-nodes.md](command-nodes.md): clients
connect to one command node, which keeps the registry of leaf nodes in its
backend, aggregates them, routes commands and runs cross-node coordinators.
This file describes what the client keeps of the earlier client-side
federation (identities, the hello, machine profiles and colours, the desktop's
connections and routes, the sidebar) and how one window shows every node: one
renderer per window holding a **node scope** per node it works with, inside
one window scope.

> **History.** The client-side federation first held one runtime per machine
> in the renderer and showed machines side by side in panels. That was
> reworked into the command node: the registry, routes, SSH tunnels and
> per-machine read model moved into the command node's backend, and a
> desktop's saved machines are imported once into its command node's registry
> (`importSavedMachinesOnce`; see
> [command-nodes-handoff.md](../development/command-nodes-handoff.md)).
> Another node's workspace was then shown as a **workspace realm**, a separate
> copy of the client per node (a child view on the desktop, a same-origin
> frame in a browser or the iOS app). Realms are retired: since plan items
> 6001-6003 (2026-11-07) every node's workspace renders in the window's own
> tree, on its own node scope, and the realm code, its window-to-realm
> protocol and the desktop realm partitions are deleted. The design and its
> reasoning are in
> [docs/reports/unified-federation.md](../reports/unified-federation.md).
> Do not extend the client-side runtime design; build on command-nodes.md.

Other references: SSH operator setup in
[ssh-routes.md](../development/ssh-routes.md), upgrade and rollback in
[federation-migration.md](../development/federation-migration.md), synthetic
measurements in
[federation-benchmarks.md](../development/federation-benchmarks.md), the
store recipe in [node-scopes.md](../development/node-scopes.md).

What exists today: one desktop window, or one hosted browser page, shows
projects and environments from several Orkestrator backends ("machines").
Each environment row starts with a coloured dot naming its machine. A
machine can be reached over HTTPS/Tailscale, over an OpenSSH tunnel, or both.

## Properties that carry over to command nodes

- A slow, offline or incompatible machine never blocks another.
- Each backend stays authoritative for its projects, environments, agents,
  workflows, approvals, files and Git. Hiding a machine, changing the
  filter, closing a panel or forgetting a machine never stops remote work.
- SSH carries the existing authenticated client API. It is not a second
  execution path, and gateway authentication still applies on top of it.

The transitional code below connects to every machine from the client and
keeps per-project coordinators inside their own backend. Under
command-nodes.md, connections move to the command node and coordinators on
command nodes span all connected nodes.

## Ownership

| Concern | Owner | Client role |
| --- | --- | --- |
| Projects, environments, agents, workflows, approvals, files | Owning backend | Render summaries; send explicit commands to the owner |
| Machine name, colour token, profile revision | That backend (`backend-profile` store) | Cache and display; edit with compare-and-swap |
| Saved machines, routes, SSH settings, encrypted tokens | Desktop native catalogue (the hosted browser keeps none) | The renderer sees safe summaries only |
| SSH processes, host-key trust, prompts | Desktop main process (`apps/desktop/electron/ssh/`) | React never spawns SSH or builds argv |
| Machine filter, grouping, collapsed sections, recently used | Client presentation (`machineViewStore`) | Persisted locally, by machine identity |
| Environment-local tabs and layouts | Owning backend (unchanged) | Rendered in the window's tree, on that machine's node scope |

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
| Desktop | `electron/federation-ipc.ts`, `ssh-prompt-broker.ts` | IPC, per-node relayed listens, askpass prompts |
| Desktop | `electron/node-scopes.ts`, `node-ipc.ts`, `node-previews.ts`, `node-workspaces.ts` | A window's node scopes: their workspace grants, node-addressed IPC and per-node previews |
| Desktop | `electron/realm-partition-cleanup.ts` | Startup removal of the retired realms' `persist:orkestrator-realm-*` partitions (plan item 6003) |
| Renderer | `apps/web/src/lib/node-scope/*` | `WindowScope`, `NodeScope`, node clients (browser registry, desktop node IPC), tiers and budgets, scoped stores, services and snapshots |
| Renderer | `apps/web/src/lib/portal/*` | The command scope's portal APIs: summaries, `invoke_on_node`, outcomes, node workspace grants |
| Renderer | `apps/web/src/lib/federation/*` | Aggregation, sidebar layout, relayed node events, in-tree scope holds, window grouping and attention, workspace requests, explicit-owner actions |
| Renderer | `apps/web/src/components/federation/*` | Provider, machine views, filter, dots, rows, sections, the central region and a node's in-tree workspace, snapshot preview, effects |
| Renderer | `apps/web/src/components/settings/machines/*` | Machines settings: list, settings, updates, SSH dialog, device toggles |

`.oxlintrc.json` forbids `@/lib/native/backend`, `@/lib/backend`,
`@/lib/native/events` and `@/lib/native/authoritative-events` imports under
`apps/web/src/lib/federation/**` and `apps/web/src/components/federation/**`.
Multi-machine views reach other nodes through the command scope's portal
APIs (`lib/portal`), which the command node routes, or through a node's own
scope. Elsewhere in the renderer, too, a transport is reached from a scope;
shrink-only source guards hold what is left
([linting.md](../development/linting.md#transports-only-through-a-scope)).

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
- `capabilities`: name to version, at most 64 entries
  (`BACKEND_CAPABILITIES`). The backend sends `backend-profile` and
  `summary-reads`, `loopback-client-gateway` while that listener is serving,
  and, in node mode, the ten node capabilities (`node-attachment`,
  `public-action-relay`, `node-mail-steer`, `node-mail-turn-origin`,
  `node-coordinator-mail`, `node-coordinator-build-origin`,
  `coordinator-notices`, `node-mail-attachments`, `node-mail-return`,
  `ticket-sync`). Only backend-to-backend code (a command node about its
  leaves) acts on them; the desktop only lists their names in its connection
  summaries, and the renderer parses the hello only to check a node's
  identity and `endpointRole` (`openLeafWorkspace`).
- `nodeMode`: `standalone`, `command` or `leaf`, when the backend has one.
- `profile`: the canonical machine profile.
- `endpointRole`: `control` on the loopback control listener, otherwise
  `client`.
- `authorizationScopeId`: defined in the contract but never sent today.
- `buildCommit`: optional. The commit this backend was built from, sent only
  when the build has one ([releasing.md](../development/releasing.md#build-commit)).
  A value that does not match `/^[0-9a-f]{7,40}$/` is dropped and the hello
  still parses.
- `domains`: contract domain name to the version range `{ min, max }` this
  backend accepts ([unified federation §11.2](../reports/unified-federation.md#112-design)),
  from the command registry's defined commands (`CommandRegistry.helloDomains`).
  Always sent, empty while no domain has a defined command. It is a top-level
  field, never a capability, and `schemaVersion` stays 1. The parser keeps
  unknown names and accepts at most 64 entries, names in the capability
  pattern and integers `0 <= min <= max <= 1000`. Anything else drops the
  whole field (logged as `contract hello.domains-malformed` with a `reason`
  only) and the hello still parses. A hello without `domains` is a
  pre-contract backend (`isPreContract`); `domainRange(hello, name)` reads one
  range.

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
  (`PreviewServicesRepository.getBackendProfile`) as `{ version: 1, revision,
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
  an offline machine (`profile.cached: true`). A command node's read model
  records each node's profile events in its registry and announces the
  change, so the renderer's summaries follow. Profile edits send the newest
  revision the client has seen. Nothing ever recolours a machine
  (`duplicateMachineColors` in `aggregate.ts` finds collisions, but no page
  shows them today). On a profile conflict the Machines page shows the
  current values and does not retry.
- Names are normalized: control and bidi characters removed, whitespace
  collapsed, at most 64 characters. A device nickname is a separate local
  alias, shown as "(on this device)", and takes precedence for display.
- Without a profile, a verified ID falls back to `defaultMachineColor`. An
  unverified machine shows the `provisionalColor` persisted with its device
  catalogue entry (derived from the entry ID when it was saved), labelled as
  cached; the canonical profile replaces it once the machine publishes one.
  The renderer's fallback for a token it does not know is `neutral`.

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
- The hosted browser has no catalogue. It talks only to the command node
  that served it, and other machines come from that node's registry.

## ConnectionManager (desktop main process)

### Bind

- Every window scope is bound to one machine: normally Local, the desktop's
  command node. Its renderer, title, previews and request authorization all
  use that machine (`use`, `release`). The `default` scope follows
  `activeConnectionId`.
- A window's node scope is its own scope, `<windowScope>:node:<nodeId>`
  (`node-scopes.ts`), pointed at another node's workspace with the client
  grant the command node issued (`retargetScopeToWorkspace`, connection ID
  `workspace:<workspaceId>`). The grant is held for that scope only, never
  saved, and revoked when the scope is released. The window's own scope never
  moves off its command node.
- There are no observation leases: other machines are seen through the
  command node, not through extra connections. `invokeOn(connectionId, …)`
  runs a command only on Local or a machine this device is connected to;
  there is no fallback to Local or to the first entry. A connection with no
  bindings is torn down (`releaseIfUnused`).

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
  delays of 1, 2, 5, 10, 30 and then 60 s (`DEFAULT_RECONNECT_DELAYS_MS`),
  each drawn from the upper half of its rung so desktops that lost the same
  machine together do not retry it in lock-step.
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

`connect` (HTTPS) and `connectSsh` add routes. A new address (Add machine)
that proves an installation already verified on this device is refused
(`identity-duplicate`) with guidance: matching IDs alone are not trusted to
merge. "Add connection method" (`connectionId`) requires the machine to be
verified already, and the new route must prove the same installation. With
multi-machine views on, adding a machine uses `select: false`: it is added
beside the window's machine instead of switching the window. If two saved
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

A connection's events go to (`relayBackendEvent`, `desktop-window-contexts.ts`):

- every window whose scope is bound to that connection and listens to the
  event, over `orkestrator:event`. A window on the direct gateway transport to
  Local already has Local's events from its own stream, so they are not
  relayed twice;
- every window node scope on that connection, over `orkestrator:node-event`,
  tagged with the node (`mapNodeConnection`).

Which connection an event belongs to comes from the receiving connection,
never from the payload. Per-node relayed events are listened to explicitly
(`addRelayedListen`), so a renderer receives only the nodes it asked for.

### Local backend unavailable

If Local fails to start and a native catalogue with saved machines exists, the
desktop starts anyway. `createUnavailableLocalBackend` rejects every Local call
with a plain message, and remote machines work normally. With no saved
machines, startup fails as before. An unexpected Local exit marks Local
unavailable and leaves remote windows connected.

## Renderer: summaries, relayed events and node scopes

A window always stays on its command node and sees the other nodes in three
ways: **summaries** the command node keeps, **events** the command node
relays, and **node scopes**, each one node's own client, stores and services
inside the window's renderer, for the nodes whose workspaces the window
opens ([Node scopes](#node-scopes-one-scope-per-node-in-the-windows-tree)).
The command node's side is in [command-nodes.md](command-nodes.md).

### The portal channel

The portal APIs (inherited settings, the node registry, grants, portal
layout, project copy, outcomes, action requests and handover) are calls on
the window's **command scope** (`lib/portal/command-scope.ts`:
`commandScopeInvoke`, `commandScopeListen`, `commandScopeListenAuthoritative`,
`commandScopeBackendClient`; plan item 5004). In an app window, and for every
node shown in its own tree, that is the command scope's ordinary transport.
No renderer file reads the page's portal global, `window.orkestratorPortal`
(the `window-orkestrator-portal` source guard, no baseline): its last reader,
the page adapter of the realm documents, and the old `portal-transport.ts`
aliases went with the web client's realms (plan item 6002).

**One machine by node id.** `machineInvoke` (`lib/backend/client.ts`, used by
agent accounts, MCP and the other machine-aware `lib/backend` functions) and
Settings' machine calls (`machine-access.ts`) go through `invokeOnMachine`
(`lib/portal/machine-scope.ts`): to the node's own scope when the window holds
it warm or live (`NodeScope.tier`) and a workspace grant admits the command
(`access: "workspace"`), otherwise through the command scope with
`invoke_on_node`. Admin commands (host updates, profile writes, diagnostics)
and commands this build has no definition for always take `invoke_on_node`,
which runs with the command node's authority.

### Summaries

- **Reading.** `portalStore` (`lib/portal/portal-store.ts`) reads
  `get_node_status` and `get_node_summaries` on the command scope. It
  re-reads, debounced by 100 ms, on
  `node-summary-changed`, `nodes-changed`, `node-status-changed` and
  `native-event-stream-connected`. A backend that predates command nodes is
  marked `unsupported`.
- **Where they come from.** The command node's read model
  (`apps/backend/src/core/nodes/node-read-model.ts`) subscribes to every
  connected node's event stream and keeps its projects and environments. Reads
  are fenced by the link epoch, so a late answer from an older connection
  never applies. They are capped at 500 projects (`MAX_SUMMARY_PROJECTS`) and
  500 environments per project (`MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT`), past
  which `truncated` is set, with at most 4 reads at once
  (`SUMMARY_READ_CONCURRENCY`), and every connected node is re-read every
  60 s (`SUMMARY_RECONCILE_MS`). A node that becomes unavailable keeps its
  last-known summaries, labelled `stale`; a new link epoch marks it
  `catching-up` until it is read again. Summaries never carry transcripts.
- **The provider.** `FederationProvider`
  (`components/federation/FederationProvider.tsx`) starts `portalStore` and
  names the **bound machine**: the command node (the portal's `selfId`),
  whichever node the central region shows. `kind` is `desktop` when the
  preload provides `isolatedViewState`, otherwise `browser` (the hosted page
  and the iOS app). `enabled` is true when the command node has other nodes.
- **Machine views.** `useMachineViews`
  (`components/federation/useMachineViews.ts`) gives one `MachineView` per
  machine. `useBoundMachineView` projects the bound machine from the window's
  own full stores (projects, environments, active builds), so it is never
  read twice. `useRemoteMachineViews` maps every other node's summary
  (`viewFromNodeSummary`), and takes the rows of a node whose scope the
  window holds warm or live from that scope's stores
  ([Summaries and scopes together](#summaries-and-scopes-together)). The
  order is the command node's registry order, then the user's portal layout.
- **Writes** are offered only while `isMachineWritable`
  (`lib/federation/aggregate.ts`): the bound machine, or a node whose
  connection is `connected`. There is no offline queue.

`useBoundMachineView` is the renderer's projection of its own stores. The
`BackendRuntime` class in `apps/backend/src/core/backend-runtime.ts` is
unrelated: it is the process state of one backend instance
([backend-runtime.md](backend-runtime.md)). The renderer has no runtime by
that name.

### Relayed events

`lib/federation/node-events.ts` is the subscription that matches reads routed
through the command node. A view names a node and the exact events it applies
(`subscribeNodeEvents`), and gets `onResync` once the subscription is in place
and again whenever events may have been missed, then `onEvent` for each event.
One lease per node (`watch_node_events`, renewed every 30 s,
`NODE_EVENT_WATCH_RENEW_MS`, and dropped with `unwatch_node_events` when the
last view leaves) covers every view's events. Frames arrive under the node's
own name (`relayed-node-event:<nodeId>`) when the command node relays that way,
or under the single old name `relayed-node-event` from an older command node,
so both are listened to. The command node's own resources need no relay:
`subscribeCommandNodeEvents` listens on the portal channel directly.

### Explicit-owner actions and unknown outcomes

`federated-actions.ts` takes the concrete `EnvironmentRef`/`ProjectRef` it was
started with and sends the node's ordinary command through
`portalStore.invokeOnNode`, which calls `invoke_on_node` on the command node
(or the command itself when the ref is the command node's own). Later focus or
filter changes cannot retarget it. A delete confirmation names the machine.

When a routed write's answer is lost, the command node records an
outcome-unknown entry against the node and answers `outcome: "unknown"`;
`invokeOnNode` throws `OutcomeUnknownError` and the write is **never resent**.
`UnknownOutcomesNotice` lists that node's records (`list_node_outcomes`) under
its section until the user dismisses them (`dismiss_node_outcome`). The older
client-side `lib/federation/operation-recovery.ts` is no longer imported.

<a id="machine-panels-one-realm-per-machine"></a>
<a id="workspace-realms-one-realm-per-other-node"></a>

## Node scopes: one scope per node in the window's tree

Opening an environment of another node shows that node's workspace in the
window's central region, rendered by the window's own React tree on that
node's **node scope**. The window (title bar, sidebar, settings, the portal)
never leaves its command node and never reloads. The pieces are in
`apps/web/src/lib/node-scope/`; the recipe for code that runs in a scope is
[node-scopes.md](../development/node-scopes.md).

- **The window scope** (`WindowScope`, one per renderer window): the
  node-qualified selection, the window-wide byte budgets, the lifecycle of
  the node scopes it holds, and the registry of node scopes, exactly one of
  which is the command scope. Other window-level state stays in ordinary
  window stores and modules every node shares: the read policy
  (`read-window-policy.ts`), chrome, sidebar and dialogs.
- **A node scope** (`NodeScope`): the node's id, its role (`command` for the
  node the window is connected to, `leaf` for any other), its `NodeClient`
  (invoke, listen, terminals, connection state, the node's negotiated domain
  versions and hello capabilities), its lazily created store instances
  (`scope.store(def)`), its running services (`scope.service(def)`), its
  version-adapted domain clients (`scope.domain(def)`), its tier and its
  health. Its lifetime is an Effect `Scope`, a child of the window's;
  `dispose()` stops its services, drops its stores, releases its byte-budget
  reservations and disposes its client. Unmounting a provider never disposes
  a scope (invariant 2).
- **The command scope** carries what the realms used to reach through the
  portal channel: inherited settings, the node registry, grants, portal
  layout, project copy, outcomes, action requests and handover
  ([The portal channel](#the-portal-channel)).
- **One workspace implementation.** `App` renders the command node's
  workspace, and `InTreeWorkspace` another node's, with the same components
  (`WorkspaceContent`, `NodeWorkspaceLayout`), each inside its own
  `NodeScopeProvider` and `NodeErrorBoundary`. Hooks read the nearest scope,
  and workspace components call their own node (`useScopeBackend`), so
  per-node state cannot be read for another node. Ids are node-local
  (Kanban ticket ids, pane ids and tab ids repeat across nodes), which is why
  each node has its own store instances rather than re-keyed shared ones.

### Opening a node

`RemoteWorkspaceRegion` renders `InTreeWorkspace` for each node it holds, and
`holdInTreeScope(nodeId)` (`lib/federation/in-tree-scopes.ts`) opens the
node's leaf scope in the window scope and hands it to the window's
lifecycle, which starts its warm services (`WARM_SCOPE_SERVICES`:
change feed, store bindings, connectivity, pane-layout persistence,
completion notes, snapshots).

- **Desktop.** Main owns one node scope per (window, node)
  (`apps/desktop/electron/node-scopes.ts`, `${windowScope}:node:${nodeId}`),
  opened with `open_node_workspace` through the command node, direct first,
  then relayed (`node-workspaces.ts`: renewed every 10 minutes, a relayed
  scope retries direct every 5 minutes). The renderer reaches it through
  `window.orkestrator.node(nodeId)` and the `orkestrator:nodes:*` IPC
  (`node-ipc.ts`); node events arrive on `orkestrator:node-event` tagged with
  the node. Main refuses machine administration for a leaf
  (`node-admin-refused`). A scope no renderer holds is released after
  15 minutes unused (`NODE_SCOPE_IDLE_RELEASE_MS`), and every scope of a
  window when it reloads, closes or changes connection. Previews of
  the node run in that scope's own preview runtime
  (`node-previews.ts`, partition `node:<nodeId>`).
- **Browser and iOS.** The page's node-client registry
  (`createNodeClientRegistry`, `lib/node-scope/node-clients.ts`) opens one
  workspace grant per (window, node) with `openLeafWorkspace`
  (`lib/portal/workspaces.ts`): direct to one of the node's origins when its
  hello answers with the node's identity and `endpointRole: "client"`,
  otherwise relayed through the command node. The grant lives only in the
  registry's closures, never in storage or the URL. A lapse, a refused
  credential or a back/forward-cache restore opens a new grant and hands the
  same transport the new bearer (`setCredential`), without a reload;
  `pagehide` revokes every grant with a keepalive `close_node_workspace`.
  Leaf terminals use the WebSocket transport, and two or more warm relayed
  leaves share one multiplexed event request
  ([command-nodes.md](command-nodes.md#opening-an-environment-on-another-node)).
- **Which nodes are held.** The node shown, and what is selected there, is
  the window's one node-qualified selection `{ nodeId, projectId,
  environmentId }` (`WindowScope.selection`, `stores/windowSelectionStore.ts`;
  plan item 3006). Each node scope's `uiStore` projects it: its
  `selectedProjectId` is the selection's project while the selection is on that
  node and `null` otherwise, and selecting there moves the selection to that
  node. `remoteWorkspaceStore` derives `active` from it (the selection while it
  is on a held node, `null` for the window's own workspace) and keeps
  `openNodes`, the nodes the central region holds, least recently shown first,
  with the window's latest request for each (`requests`, applied on the
  node's stores by `NodeWorkspaceHost` once they have what it needs). No count
  caps them: the tiers below decide what each costs. The command node's
  selection survives a reload of the window (session storage).

### Tiers

The window's lifecycle (`WindowScope.lifecycle`, `ScopeLifecycle` in
`lib/node-scope/lifecycle.ts`; plan item 4002) moves each leaf scope it
manages between four tiers. The command scope is never managed and is always
`live`.

| Tier | What exists | Streams |
| --- | --- | --- |
| `summary` | No scope: the node is listed from the command node's summaries and heard through its relay | none of its own |
| `warm` | The scope, its light stores and warm services; reads paused while hidden (`setReadCoordinatorScopeHidden`) | the node's main stream |
| `live` | The shown node: warm plus its workspace's heavy data (transcripts, terminals, files, previews) | plus terminals and previews |
| `suspended` | Light store data kept; services stopped, `client.suspend()` (cursor kept) | none |

A hidden node turns `warm`; past the host's suspend time it turns
`suspended`; shown again it resumes from its cursor, and a gap there takes
the ordinary resync path, so its stores re-read authoritative snapshots.
`InTreeWorkspace` keeps a node's views mounted while it is warm, live or
shown; a suspended hidden node unmounts them (its light stores stay), and a
node taken back to `summary` reopens when the selection shows it again.
Switching nodes never stops work on any node: suspending closes only this
window's streams. Before a scope's streams close, its attention is handed to
the command node's relay (`attentionHandoff`, plan item 5001), so a question
on a suspended node still notifies.

### Budgets

Memory is bounded per window, never per node, so more nodes do not multiply
it (invariant 11).

- **Byte budgets** (`ByteBudget`, `lib/node-scope/byte-budget.ts`): one per
  kind of heavy data, shared by every node scope of the window (transcripts
  32 MiB, artifacts 16 MiB, images 32 MiB by default; half of each on iOS).
  Each entry reserves its bytes under its node; the budget evicts other
  nodes' least recently shown entries first, then this node's, never the
  shown node's.
- **Memory budget** (`HOST_LIFECYCLE_DEFAULTS`, `lib/node-scope/lifecycle-config.ts`):

  | Host | Suspend after | Budget | Reading |
  | --- | --- | --- | --- |
  | Desktop | 15 min | 1 GiB of renderer heap | measured heap, else estimate |
  | Browser | 5 min | 512 MiB | `performance.measureUserAgentSpecificMemory` where allowed, else heap, else estimate |
  | iOS | 2 min, and when the page is hidden | 128 MiB for the node scopes | estimate (24 MiB per warm or live scope, 4 MiB per suspended one) |

  Above the budget the pressure path runs one step at a time, re-reading
  after each: drop a hidden node's heavy data, then suspend the least
  recently shown warm node, then dispose the least recently shown suspended
  one back to `summary`. It never touches the shown node. An iOS memory
  warning (`orkestrator:memory-warning`) is a sweep: every hidden scope drops
  its heavy data and suspends, and every scope already suspended goes back to
  `summary`.
  Every value is a placeholder until per-scope cost is measured
  ([report §8.2](../reports/unified-federation.md#82-budgets-per-host)) and
  can be overridden per window (`WindowScopeOptions.lifecycle`).

### Snapshots

A node opened again after its scope was disposed, or after a restart,
paints at once from a local snapshot (plan item 4003; `lib/node-snapshots.ts`,
`lib/node-scope/snapshot-store.ts`). A warm scope writes its light-store
snapshot (projects, environments, presentation config, pane layout ids, the
last selection) to IndexedDB under its node id: 5 s after it opens, every
30 s, when it turns `live` and when it stops, and only once it holds
authoritative projects and environments. Records are bounded (256 KiB per
node, 2 MiB in total, 32 nodes, least recently used evicted) and decoded
against an allow-list schema that refuses anything else, so a snapshot never
holds transcripts, terminal or file contents, prompts or credentials
(invariant 12). On open the scope is hydrated from it before its services
start and marked `resyncing` (`snapshot-sync.ts`); `NodeSnapshotPreview`
shows the node read-only with a "Saved …" marker (`SnapshotStaleMarker`)
until the authoritative reads land, and its mutations wait (at most 30 s,
then `ScopeResyncingError`). The command scope does the same for the
window's own node (`ScopeSnapshotGate`). A node removed from the registry
loses its snapshot, and every whole-window protected-content clear drops
them all.

### Summaries and scopes together

Summaries are the floor for every node, whatever its tier: the sidebar, the
⌘K search and the title bar's per-machine readings show every other node
from the command node's summaries, and the command node's own rows from the
window's full stores (`useBoundMachineView`). Attention from a warm or live
node arrives on its scope's client, and from every other node through the
command node's relay (`lib/federation/window-attention.ts`). A node's scope
overlays its full stores where its workspace is drawn: the central region,
its dialogs, the files panel and the bug report sheet on that node read the
scope, never the summaries.

**The overlay** (`lib/federation/scope-overlay.ts`, plan item 5007). The
same reading holds for a node's rows in the sidebar, the ⌘K search and the
title bar's names and merge-ready shimmer of the node on screen: while the
window holds its scope `warm` or `live`, `useRemoteMachineViews` takes its
projects and environments from that scope's `projectStore` and
`environmentStore` (`machineViewWithScopeRows`), so a change the scope hears
on the node's own stream, such as an environment renamed, shows without
waiting for the next summary. Every other node, and a `summary` or
`suspended` one, keeps its summary rows.

- **The same row either way.** The scope's records go through the projection
  the command node applies to the node's summary reads
  (`toNodeProjectSummary`, `toNodeEnvironmentSummary`), with the same caps
  (500 projects, 500 environments per project, `truncated` past them) and
  the same order (each list by the node's own `order`). What a summary read
  adds to the ordinary records is not in the scope's stores and is kept from
  the summary: the PR monitor health (`prMonitorConfirmed`,
  `prViewerCanMerge`, `prCheckSummary`), `buildPipeline`, `buildActive`, the
  agent-mail badge, Docker availability (which a row created since the last
  summary takes from the machine's other rows) and a project's
  `defaultBranch`. A project's icon is the scope's, so past the summary's
  shared icon budget (256 KiB per node) a warm node's projects keep theirs.
- **When the scope is used.** Only a leaf scope, while its tier is `warm`
  or `live`, its client hears the node (`connection` `live` or
  `resyncing`), and its stores hold the node's authoritative projects
  (`projectStore.hasLoaded`) and environments (the environment resync's
  `noteAuthoritativeRead`, `scopeAuthoritativeReads`). A scope painted from
  its snapshot ([Snapshots](#snapshots)) therefore shows the summary until
  its own reads land. The view's machine-level fields (connection,
  freshness, `loadedAt`, release) stay the command node's, so writes are
  offered on the same rule as before (`isMachineWritable`).
- **No flicker.** Rows are keyed by node-qualified key on both sources, so
  a tier change re-renders a row in place; with the same data the drawn rows
  are identical, and a row that differs takes the newer source's values.
  `scopeRowsSource` keeps its snapshot's identity while no node's rows
  changed, so the machine views re-render only on a real change.

Detail beyond a row still comes from routed reads (`useNodeEnvironment`,
`node-environment-reads.ts`). The parity tests keep a summary row and a
scope row alike: `environment-row-model.parity.test.ts` (every row case
through both), `scope-overlay.test.ts` (a whole machine view, the bounds,
the readiness rules) and `sidebar-parity.test.tsx` (the drawn sidebar across
summary, warm, live and suspended, and a rename shown before the summary),
next to `remote-row-parity.test.tsx` for a summary row and this window's.

### Failure isolation

A render error in one node's workspace shows that node's `NodeErrorBoundary`
with Try again; the command node's content has its own. A service that
throws on start, or whose `done` rejects, marks only its own scope `failed`
(`NodeScope.health`, retryable). There is no process isolation: every node's
workspace shares the window's renderer, which is why the budgets above
matter most on iOS.

### Retired: workspace realms

Until plan items 6002 (web) and 6003 (desktop), each other node's workspace
was a **realm**: a full copy of the client per node, bound to that node only
(a `WebContentsView` per node on the desktop, a same-origin `<iframe>` in a
browser or the iOS app), with a window-to-realm message protocol, a realm
URL, a realm grant in the tab's `sessionStorage`, a cap of open realms and a
storage partition per desktop realm. Each part's replacement:

| Realm part | Now |
| --- | --- |
| Realm document and its URL (`?realm=workspace`, `@orkestrator/protocol/realm-request`) | `InTreeWorkspace` on the node's scope; requests are `WorkspaceRequest` values in `remoteWorkspaceStore` (`lib/federation/workspace-request.ts`) |
| Window-to-realm messages (select, grouping, visibility, title bar, shortcuts, bug report) | Direct calls and shared window stores (plan items 4005, 5002, 5003) |
| Portal channel (`window.orkestratorPortal`, `portal:invoke`) | The command scope ([The portal channel](#the-portal-channel)) |
| Realm grant in `sessionStorage` | The browser registry's closures; main on the desktop |
| `MAX_OPEN_REALMS`, `DEFAULT_MAX_VIEWS` | [Tiers](#tiers) and [Budgets](#budgets) |
| Desktop realm partitions `persist:orkestrator-realm-<slot>-<hash(nodeId)>` | Abandoned ([Decision 13.7](../reports/unified-federation.md#137-desktop-realm-partition-data) A) and removed at startup (below) |

On startup, before any window exists, desktop main deletes every directory
under its own `userData` `Partitions/` whose whole name is
`orkestrator-realm-<slot>-<16 hex>` (Electron's on-disk name for a realm
partition), and nothing else (`realm-partition-cleanup.ts`); it logs only
counts (`realm-partitions.removed`, `realm-partitions.remove-failed`).

### Workspace boot

A window's start, and a node scope opened again after the lifecycle took
it back to `summary`, read the node's data afresh (a snapshot paints first,
[Snapshots](#snapshots)). Three things keep that short and measurable
(2026-11-06, measured on the realm boots of the time: cold opens of
omarchy-hp from mbp3 were slow, warm opens fast):

- **Render does not wait on the catalogue seed.** `startApp`
  (`apps/web/src/lib/app-startup.ts`) reads the stored host model catalogues
  with `get_agent_model_catalog_cache` `{ seed: false }` (the cache as stored:
  no download, no Pi probe), bounded at 2 s, then renders. The seed (`seed:
  true`, which can start a bridge and CLI per enabled platform with no cached
  list) runs after the render, once that read settles or reaches the timeout,
  and updates the model stores when it answers. An older backend treats `seed: false` as an
  omitted `seed`.
- **A failing seed is not retried every boot.** A failed or empty host
  catalogue download cools down for 15 minutes
  (`HOST_CATALOG_SEED_FAILURE_COOLDOWN_MS`, `host-catalog-seeds.ts`; it was
  30 s). An empty catalogue counts as a failure. A completed sign-in clears it
  (`resetCooldown`), and Settings' Refresh downloads without consulting it.
- **The hydration fan-out is bounded and batched.** At most six hydration
  reads are in flight per renderer document, shared by every node the window
  hydrates (`HYDRATION_MAX_IN_FLIGHT`, `hydration-request-limiter.ts`): `get_environments`,
  `get_environment_snapshots`, `list_build_pipelines`, `list_prompt_queues`,
  `list_multi_review_workflows` and `list_environment_hydration`. Docker-reconciling
  `get_environments` reads have a two-request admission limit inside that same
  six-slot bound; waiting environment loads consume no shared slot, so a slow
  Docker snapshot cannot starve persisted snapshot, pipeline or queue reads. The boot
  restore of prompt queues and Multi Review workflows (`App.tsx` through
  `boot-hydration.ts`) collects the environments requested in one task and
  reads them with one `list_environment_hydration` call per 100
  environments, instead of two requests per environment; each environment and
  list still fails on its own. A failed batch falls back to individual list reads
  for its chunk, isolating transport or validation failures. Against an older
  backend the batcher falls back to the per-environment reads after one "unknown command". A 10-project,
  120-environment boot restores with 10 requests instead of 240
  (`boot-hydration.test.ts`). The manifest resync's own per-environment reads
  (`store-resource-sync.ts`) are bounded but not batched.

**Open timing in the saved log.** Opening a node's workspace writes
content-free `[workspaces]` lines to the desktop's log (the Electron main
process's, see [logging.md](logging.md)), each with `nodeId`, `nodeName` and
`durationMs`:

| Event | Written by | Step |
| --- | --- | --- |
| `workspace.opened` | main process (`node-workspaces.ts`) | The `open_node_workspace` call, which issues the node's client grant; `directRoutes` counts the routes to probe. |
| `workspace.route-probed` | main process | One direct (or loopback) route probe: `route`, `attempt`, and an `outcome` from a fixed list (`hello`, `other-node`, `legacy`, `unreachable`, `timeout`, `authentication-required`, …). Never the origin. |

## Sidebar presentation

When multi-machine views are enabled (`federation.enabled`: the command node
has at least one other node),
`HierarchicalSidebar` replaces the switch-and-reload `ServerConnectionSwitcher`
with `MachinesFilter`:

- The filter offers **All machines** (the default), each machine, and
  **Manage connections…**. It also shows connected/total (`2/3`) and a label
  such as `2 connected · 1 unavailable`. It never says "all caught up" while a
  machine is missing (`connectivitySummary`).
- Changing the filter is presentation only. It never closes a transport or
  a node scope.
- Grouping options are **By machine** (the bound machine's full tree, then
  `RemoteMachineSection` per other machine, in that backend's order), **By
  project** (instances with machine badges; equal names stay separate) and
  **By repository**. **By activity** gives one list across the selected machines,
  with an **Order** radio group. The projections live in `aggregate.ts` and never
  merge records.
- **Compact** is one more group-by mode, also offered in a window that names no
  machines (whose menu calls its ordinary list **Full list**). See
  [Compact sidebar](#compact-sidebar).
- Repository grouping uses only a sanitized `host/owner/name` hint derived
  from the project's Git URL (`repositoryHint`), or an explicit mapping
  argument. Names, paths and branches never group projects.
- A repository heading's tile shows `repositoryIcon`: the command node's icon
  for its copy of the repository (none means the house, even when another
  machine has one), else, when the command node has no copy, the first icon in
  machine order. Right-clicking the heading opens its menu, which acts on the
  member the heading opens and names its machine: Open Coordinator (absent where
  the coordinator is gated), Open Board, Open Repo on GitHub, Repository
  Settings, New Environment and Expand/Collapse. Settings and New Environment
  are disabled while that machine is not writable, as on a project header.
- Activity order offers **Priority order** (the default for both local and
  federated lists), **Newest first**, and **Oldest first**. Every order keeps
  merged environments below unmerged ones and, within each, working environments
  below the others. Within those groups priority puts unread work first, then
  waiting and idle, newest first within each; the other two order by time alone.
  A machine that predates `prState` in its summary sends none, so its merged rows
  stay with the unmerged ones. The local list, the federated list and `orkestrator environment list --sort`
  share one comparator (`@orkestrator/protocol/environment-activity-order`), and
  this machine's rows rank the activity they display in both lists, so an active
  build counts as working. All three orders use `lastActivityAt`, the time of actual user/agent
  activity, independent of snapshot writes and lease refreshes; priority alone
  falls back to the activity snapshot timestamp for a record without one (an older
  remote backend). Missing or invalid activity times follow dated rows in Newest
  first and precede them in Oldest first. Federated ties use backend ID, project order, environment order, then
  environment ID; local ties use project order, environment order, then environment
  ID; the CLI keeps the backend's order. Timestamps come from different clocks, so
  this is a presentation sort only. The selected order is persisted and applies
  when filtering to one machine too.
- `EnvironmentStatusMarker` sits immediately before every environment name:
  federated rows and the bound machine's `EnvironmentItem`. Its 8 px
  `MachineDot` center sits inside a 16 px ring, without a separate outline. While
  working the ring is a spinner fading from light grey to nothing, in the
  marker's own shape; while waiting for input it is a halo pulsing yellow. The
  machine colour stays steady throughout the animation; clients without a
  machine identity use a neutral center. Under reduced motion the spinner holds
  still. Stopped environments have a faint outline, while running idle
  environments have no halo. Local
  environments use a circle and containers a square. An unavailable machine's
  rows are dimmed and read "Connection lost; last observed …", never "stopped".
  The dot is decorative when the label names the machine, and an image otherwise. In
  forced-colours mode the center uses `CanvasText`; working and waiting keep
  static 2 px `CanvasText` outlines (solid and dashed respectively), while
  inactive and idle halos are hidden. Machine dots keep an outline and compact
  badges show the name. "Compact machine labels" reduces labels to the dot plus
  a tooltip.
- A row of the bound machine selects in place. A row of another machine opens
  its machine's workspace; its actions menu adds Open workspace and Copy link to
  the actions every row has, and disables writes while the machine is not
  writable.
- `FederationEffects` handles `?resource=<encoded {b, e|p}>` links
  (`encodeResourceLink`). The link names a machine and a resource, never a
  route, port or token. A link for an unsaved machine offers to add a
  connection instead of resolving against this window. The same component
  shows attention toasts ("Waiting for input", "New completed work") for
  other machines, deduplicated by machine-qualified key.
- The project search (⌘K, and the sidebar's search field, which opens the
  same dialog) searches every machine in one merged list; see
  [Project search](#project-search).
- Settings pages show a scope banner: **All machines** for Machines,
  **Backend: name** for everything else, which always targets the window's
  bound machine.

### Compact sidebar

Compact (`grouping: "compact"`, persisted like the other modes) makes the
sidebar one large icon wide (56px), listing only top-level repositories.

- **The list** is `compactRepositories`: the "by repository" tree, one icon per
  group, so a repository on several machines is one icon. A project that reports
  no repository is its own icon. A window that names no machines lists its own
  projects, folders flattened away. Every connected machine counts: the machine
  filter's control is not on screen, so it does not apply here (it is kept for
  the other modes).
- **An icon** reuses `CommandNodeHomeIcon` (`repositoryIcon`, as a repository
  heading has; a repository with none shows the house tile) inside
  `CoordinatorActivityIcon`. Its outline is `repositoryTileColor`,
  also as on a heading: the command node's colour while it has a copy of the
  repository, else the colour of the machine whose coordinator a click opens. The
  name is a tooltip and the accessible name, and there is no other text.
- **Opening** a repository goes where its heading goes (`openRepository`), and a
  project with no repository where its row goes. The icon of whatever project is
  shown is marked selected, and the sidebar stays compact. For another node's
  workspace compact counts as `repository` (`windowGroupingFor`,
  `lib/federation/window-grouping.ts`), since it links a repository's projects
  the same way.
- **Status** is `compactRepositoryStatus` over each member's facts, read from what
  its project row reads: this window's stores for its own, the node summary for
  another machine's, which has no coordinator activity. The ring spins while a
  coordinator, project home, or ordinary repository environment (including an active
  build) works and halos while one waits. The spinner wins,
  as on a row, and the badge then carries the wait. The badge is a dot, never a
  count: amber for unread work, a failed agent message or that hidden wait, cyan
  for unread agent mail.
- **The header** is only the sort icon, whose menu has no sort section and offers
  every list, including **By activity**, so compact can be left with a mouse. The
  search bar is not mounted, so ⌘K does nothing and is not held for later. The
  footer actions stay, stacked. A multi-selection is cleared, having no rows.
- **Sorting by activity** does not replace compact, which lists no environments.
  Both are kept: `groupingBeforeCompact` is what leaving compact restores there.
- **The phone layout's** overlay has no compact form. It falls back to the
  repository list (or activity list when sorted by activity), and the choice is
  kept for desktop widths. The grouping another node's workspace follows
  (`useWindowGrouping`) is the displayed list's.

**Rotating modes.** ⌘⇧D / Ctrl+Shift+D (`rotate-sidebar-grouping`) walks **By
machine → By project → By repository → Compact** and back
(`nextSidebarView`). It skips what would change nothing: the merged modes while
no other machine is shown, and compact in the phone layout. Sorted by activity,
when the groupings are not on screen, it moves between the activity list and
compact.

**Width.** `useSidebarPanelMotion` moves the panel between full, compact and
hidden, so showing and hiding animate too and the panel stays mounted. `index.css`
transitions the panels' `flex-grow` for 180ms, only while the group carries
`data-sidebar-width-animating`; a held resize handle turns that off, as does
`prefers-reduced-motion`. For the duration, the sidebar's and the main column's
content are held at the larger of their start and end widths and clipped by
their panels (`sidebarMotionPins`). A hidden sidebar has no resize handle, so
showing mounts it and hiding removes it on release; the main column's hold
includes the handle's width for those changes, or the column would be laid out
once more when the handle comes or goes. So a terminal or editor is laid out at most
twice instead of on every frame, and its PTY is resized at most twice. A frame after
the release one `resize` fires, because a native preview follows its host only on
a resize. A native preview therefore stays put during the transition and moves
when it ends. Waiting that frame makes a terminal's fit from this event and from
its own `ResizeObserver` a single fit.
`e2e/agent-testing/sidebar-width-consumers.spec.ts` measures a real terminal and
Monaco editor through these changes.
The handle is disabled in compact. The full width is kept in
`uiChromeStore.sidebarWidth` (the window's chrome, shared by every node) while compact or hidden, so it returns on leaving, across
reloads too.

### One presentation for both paths

A machine's projects and environments look the same whether the window is
bound to that machine or shows it through a command node. Each piece is one
component with two thin adapters:

| Piece | Shared component | This window's adapter | Another machine's adapter |
| --- | --- | --- | --- |
| Environment row | `EnvironmentRow`, drawn from `environmentRowModel(facts)` | `EnvironmentItem` (`localEnvironmentRowFacts`) | `RemoteEnvironmentItem` (`nodeEnvironmentRowFacts`) |
| Row frame (grip, selection, offline dimming) | `SortableEnvironmentRowFrame`, `activityRowClassName` | `SortableEnvironmentItem` | `RemoteSortableEnvironmentItem` |
| Delete confirmation | `EnvironmentDeleteDialog` | through `EnvironmentRow` | through `EnvironmentRow` |
| Project header | `ProjectGroupHeader` | `SortableProjectGroup` | `RemoteProjectGroup` |
| Project home activity | `ProjectHomeActivityButton`, `projectHomeStatus` | `ProjectHomeActivity` | `RemoteProjectGroup`, `RemoteActivityHome` |
| Compact icon status | `compactRepositoryStatus`, `projectHomeStatus` | `useCompactStatuses` | `remoteMemberFacts` |
| Activity list | `ActivityEnvironmentList`, `compareActivity` | `HierarchicalSidebar` | `FederatedActivityList` |
| Empty project list | `SidebarEmptyState` | `HierarchicalSidebar` | `MergedProjectList`, `RemoteMachineBody` |
| Drag card | `SidebarDragOverlay` | `HierarchicalSidebar` | `MergedProjectList`, `RemoteMachineTree` |

The adapters only gather facts (from this window's stores, or from
`NodeEnvironmentSummary`/`NodeProjectSummary`, which for a warm or live node
are its scope's records in the summary's shape,
[Summaries and scopes together](#summaries-and-scopes-together)) and actions. When changing what a
row, header, badge, icon, menu, hover card, filter or sort shows:

- Change the shared component or the model, not an adapter. A new fact goes in
  `EnvironmentRowFacts`, which both adapters must then supply.
- If another machine's adapter needs data it does not have, add a bounded,
  optional, content-free field to the node summary (`node-summaries.ts`) and to
  the machine's summary read (`get_environment_snapshots` with
  `includePrMonitorHealth`), so older machines degrade to the previous display.
  If the field changes on an event other than an environment change, make
  `NodeReadModel` re-read on it (agent mail does). If only the summary read
  adds it (it is not in the node's ordinary environment record), list it in
  `SUMMARY_ONLY_ENVIRONMENT_FIELDS` (`scope-overlay.ts`), so a warm node's row
  keeps it from the summary.
- Add a case to `environment-row-model.parity.test.ts`, which feeds one
  environment through both adapters and requires the same row, or a rendering
  test to `remote-row-parity.test.tsx`.
- The only intended differences follow from the row being on another machine:
  clicking opens that machine's workspace, "Open workspace" and "Copy link"
  exist, writes are disabled while it is unavailable, and items that need this
  window's own host ("Copy
  Address", "Copy Initial Prompt", "Merge PR", the clickable port, the
  design-canvas deletion notice) are absent. "Merge PR" opens this window's
  action-bar merge dialog for the environment (`mergePrRequestStore`), so it
  exists only where that dialog can act. A section of a machine that has never been
  reached says "Not available yet.", a state its own sidebar cannot have.
- A machine header shows the machine's version when it differs from the
  command node's, with the domains it lacks, and leads to its update
  (`MachineView.release`, which every adapter supplies from the command
  node's summaries; see
  [Keeping the fleet current](host-updates.md#keeping-the-fleet-current)).
- Container actions are gated by the machine's own Docker availability, which
  its summary read stamps on every row (`dockerAvailable`, from a 30-second
  cache of `check_docker` answers and a bounded probe). A machine that predates
  the field sends none, and its rows treat Docker as available, as before.
- Multi-select is the same for every row, whichever machine owns it
  (`lib/sidebar-selection.ts`). Cmd/Ctrl-click toggles a row and Shift-click
  selects a range, without opening anything. A range runs over the rows as
  drawn (read from `data-environment-selection-id`), so it follows every
  grouping, sort and filter and skips what is collapsed. A selection holds this
  window's rows by environment ID, which is what its stores use, and another
  machine's by node-qualified key, because the same ID can exist on two
  machines.
  A delete in flight cannot be selected. A failed merge cleanup can, on either
  path, so a bulk delete can retry it: `deletionRetryable` on the node summary
  (an optional boolean; a machine that predates it keeps such a row unselectable)
  and `isLocalDeletionRetryable` on this window's rows.
- Bulk Stop, Restart and Delete resolve each selected row to its owner
  (`lib/federation/selected-environments.ts`) and send it through the same path
  as that row's own action (`useSelectedEnvironmentActions`). An environment on
  an unavailable machine is skipped and reported, and the delete confirmation
  names each environment's machine. A row that no longer exists leaves the
  selection.

[2190](../todo/cross-cutting/2190-direct-and-command-node-sidebar-parity.md)
records how the two paths were merged and what remains.

## Project search

`ProjectSearchBar` and its ranking, `searchProjectsAndEnvironments`
(`apps/web/src/lib/project-search.ts`), are the only search over projects and
environments. The ⌘K shortcut and the sidebar's "Search projects,
environments..." field open the same dialog, so they behave identically.

- **Sources.** This machine's rows come from its full stores
  (`localSearchSource`); every other machine's from its summaries, or from
  its scope's stores while the window holds it warm or live
  (`machineSearchSource`, over `useMachineViews`;
  [Summaries and scopes together](#summaries-and-scopes-together)). Both are normalized into
  the same records with the same helpers (`repositoryHint`, `pathName`), so a
  remote row matches on exactly the fields a local row does: project name,
  repository owner/name and repository name (never the host or scheme),
  checkout directory name; and for environments also the environment name,
  branch, type and worktree directory name. The default branch is not a
  match field; it marks an environment on it as `primary`. Project homes have
  no row, as in the sidebar. Other machines are searched only in a
  multi-machine view (`federation.enabled`).
- **One merged list, one row per machine.** Projects and environments from
  every machine share the Projects and Environments sections; a project on
  five machines is five rows. In a multi-machine view every row carries a
  `MachineBadge` (dot and name) and an accessible name naming the machine and
  project (`"telegram-scraper, project on mbp3"`, `"run-desktop-app,
  environment of orkestrator-v2 on mbp3"`). Remote rows are keyed by machine
  (`<connectionId>:<id>`); this machine's rows keep their plain IDs. "No
  projects or environments match that search." appears only when nothing
  matches on any machine in scope.
- **Ranking.** Most recently used first, across machines, then match quality
  (exact, prefix, substring per token), then: projects by machine (this one
  first, then sidebar machine order) and sidebar order; environments by last
  activity (falling back to creation time). The empty query lists recents the
  same way (8 per section); a query shows up to 50 per section, after
  merging.
- **Recently used.** `machineViewStore.recentKeys` (persisted with the rest
  of the window's cross-machine view state, at most 64) holds node-qualified
  `projectKey` / `environmentKey` values, newest first. This window's own
  selections are recorded from the command node's `uiStore` (`FederationEffects`); another
  machine's project or environment is recorded when it is opened
  (`remoteWorkspaceStore.open`), when the shown node's own selection changes
  (`NodeWorkspaceHost`, `noteNodeSelectionRecents`), or chosen in the search.
  A node that is not shown does not change recency.
  The node's older `recentProjectIds` follow as a fallback. Nothing is written to the window's
  workspace stores, and no remote ID is resolved against them.
- **Filters.** Tab and Shift+Tab cycle All / Projects / Environments over
  every machine. The Filter menu adds a **Machine** group (shown when other
  machines exist): All machines (default), This machine, or one machine, each
  marked offline/stale/loading when it is. Both reset when the dialog closes.
- **Choosing a row.** This machine's rows select as before. Another machine's
  project is selected in the sidebar, not opened (`useRevealMachineProject`):
  it is recorded as recent, its machine section, folder (by machine, by
  project and by repository) and project are expanded, a sidebar machine
  filter that hides it is cleared, and the row is highlighted
  (`machineViewStore.revealedProject`) and scrolled into view until something
  else is selected. When the current layout cannot show it (sorted by
  activity, or a merged list hiding a disconnected machine), selection switches
  to the by-machine project view immediately. Another machine's environment
  opens on that machine (`openMachineWorkspace`), as its sidebar row does.
- **Offline, stale and loading machines** keep their last-known rows, greyed
  (`opacity-60`) with an offline/stale/loading label, and can still be
  chosen: a project is revealed in the by-machine sidebar, which keeps its
  last-known tree; an environment opens as from the sidebar. While a machine
  in scope is unavailable, loading or truncated the dialog (including empty-query
  recents) says "Results may be incomplete".

## Storage namespacing

`desktopConnectionStorageKey(baseKey, node)`
(`apps/web/src/lib/desktop-storage-key.ts`) takes the node the data belongs
to, a `StorageNode` (`{ nodeId, role }`; a `NodeScope` is one, and
`COMMAND_STORAGE_NODE` names the window's command node). Stores call
`nodeStorageKey(baseKey, node)` (`apps/web/src/lib/persistence-keys.ts`), which
adds any one-time move from a legacy key (`PERSISTENCE_KEY_MIGRATIONS`).

- **A leaf** gets `<base>:machine:<hash("machine:" + nodeId)>` in every
  renderer: the key the browser and iOS workspace realms of earlier releases
  wrote in shared origin storage, so a leaf reads its existing state. On
  desktop that form is new (the desktop realms' partitions are abandoned,
  [Decision 13.7](../reports/unified-federation.md#137-desktop-realm-partition-data)).
  A leaf key never adopts the un-namespaced legacy value, which is the
  command node's.
- **The command node** keeps the key it had before nodes were named: in a
  browser the base key, and in Electron renderers (`isolatedViewState`) the identity key
  below, with its adoptions. It ignores the node id, so the key is the same
  before and after the command scope proves its id.

Web annotation local drafts moved to
`orkestrator.web-annotations.local-drafts.v2`, namespaced per node; the
un-namespaced v1 value moves once into the command node's key (plan item
[3015](../../plans/unified/3015-persistence-keys-per-node.md)).

On desktop the command node's namespace comes from
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
  (`getRendererRequestAuthorization`). A window's one hook covers its command
  scope and every node scope it holds, longest matching gateway prefix first
  (`window-request-authorization.ts`).
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
| Freshness (`SummaryFreshness`) | `initializing`, `current`, `catching-up`, `stale`, `degraded` | The command node's read model |
| Activity | `idle`, `working`, `waiting` (backend `agentActivityState`), shown as last-observed while disconnected | Owning backend |

`machineStatusText` shows these as Connected, Catching up, Connecting,
Reconnecting, Sign-in needed, Blocked: verify this machine, Not supported by
this client, Not connected, or Unavailable · last seen ….

## Feature flags

The flags live in the catalogue's `features` and are edited under Settings →
Machines → This device (`setFeatures`). Each defaults to `true`. Turning one off
stops client machinery only, never remote work.

| Flag | Off means |
| --- | --- |
| `federation` | Saved and shown under This device ("Show all machines together"), but nothing reads it today: multi-machine views follow the command node's registry (`federation.enabled`), not this flag. |
| `sshRoutes` | SSH is removed from `supportedRouteKinds`. Live SSH connections hand over, or fail if the machine has no HTTPS route. `connectSsh` and host-key probes are refused. |
| `routeFallback` | Only the preferred or current route is tried. Repeated stream drops never switch routes. |

The hosted browser has no catalogue, so it has no flags and no toggles
(`ClientOptions` renders only where `window.orkestrator.connections` offers
`setFeatures`).

## Known limitations

Plan items that are not implemented, or only partly, as of this change.

- **One renderer per window.** Every node's workspace runs in the window's
  renderer, so there is no process or storage isolation between nodes:
  isolation comes from per-node store instances, the scope provider,
  node-tagged events and the source guards
  ([node-scopes.md](../development/node-scopes.md#rules-the-guards-hold)).
  One out-of-memory takes the whole window. The tier budgets are
  placeholders until per-scope cost is measured, and the iPad has not been
  measured with several warm nodes ([report §15](../reports/unified-federation.md#15-not-done--needs-live-evidence)).
- **Browser and iOS leaves.** A direct session needs the node to answer the
  page's probe (its gateway must accept the page's origin,
  `--allowed-origins`); otherwise the node is relayed through the command
  node. A leaf's media, loopback and preview URLs always use its relay base,
  even on a direct route, because an element load cannot carry the bearer.
  Grants live only in the page's memory, so a reload opens new ones; a hosted
  page whose gateway needs a bearer (`apps/web-public`) cannot close its
  grants on `pagehide`, and they expire on their 15-minute TTL.
- **Desktop leaf previews.** A relayed leaf's address-bar preview is not
  supported (its base has a path prefix that main's gateway-preview checks
  refuse), as with the realms before.
- **Mobile**: the iOS app shows other nodes in its one `WKWebView`, as a
  browser does. There is no mobile SSH.
- **SSH**: macOS and Linux desktop only; Windows is not qualified; no SSH in
  browsers. Nothing installs or starts a remote backend and there is no SSH
  pairing for the gateway token. No ControlMaster multiplexing. No UI
  removes or rotates a trusted host key: changed-key recovery is manual (see
  [ssh-routes.md](../development/ssh-routes.md)). A ProxyJump hop's key is
  verified by the user's own SSH configuration, outside Orkestrator's
  known_hosts. Askpass prompts go to the focused main window.
- **Grants**: the hello never sends `authorizationScopeId`. Grant equivalence
  is identical token strings, so routes with different tokens never fall back
  automatically; the user picks a route explicitly.
- **Identity conflicts**: two saved entries proving one installation are shown
  as a conflict (and keep provisional identities), and a new address that
  proves an already-saved installation is refused with guidance to add it as a
  connection method. There is no merge or re-pair UI; resolve a conflict by
  forgetting one entry.
- **Summaries** are capped at 500 projects and 500 environments per project
  with a truncation notice and no pagination. Detail beyond them comes from
  reads routed through the command node (`useNodeEnvironment`,
  `node-environment-reads.ts`) or from the node's scope once its workspace is
  open. Last-known summaries
  are kept by the command node's read model, survive its restart, and are
  shown as `stale` while the node is unavailable.
- **Repository grouping** has no UI for explicit user mappings, and backends
  publish no repository hint; the client derives a credential-free
  `host/owner/name` from `gitUrl`.
- **Revocation**: there is no per-device "revoke this device" action (the
  gateway has one shared token) and no revocation signal from the backend.
  The command node keeps a node's last-known summaries, labelled `stale`,
  whatever made the node unavailable, including a rejected credential.
- **Links**: machine-qualified links are a `?resource=` page parameter
  (Copy link on other machines' rows); desktop has no OS URL handler.
- **Route policy**: no "prefer fastest" mode (optional in the plan).
- **Performance**: only the synthetic in-process benchmark is recorded
  ([federation-benchmarks.md](../development/federation-benchmarks.md)); the
  real-backend matrix (p95 approval/completion visibility, bytes per minute,
  multi-client) is not measured.
- **Migration edges**: see
  [federation-migration.md](../development/federation-migration.md). An older
  client sees the version-1 list as it was at migration time.

## Acceptance-ID map

Test names carry the plan's scenario IDs (section 22). Paths are relative to
the repository root. Real-sshd suites run only with
`ORKESTRATOR_SSH_INTEGRATION=1`; see
[ssh-routes.md](../development/ssh-routes.md#real-sshd-integration-test).

Historical map: `federation-runtime.test.ts`, `scripts/benchmark-federation.ts` and
`scripts/qa-federation-browser.ts` were removed with the client-side runtime,
and the observation tests of `connection-manager-federation.test.ts` went
with it. The command-node equivalents are in the requirement matrix of
[command-nodes-plan.md](../development/command-nodes-plan.md#requirement-matrix).

| ID | Tests |
| --- | --- |
| ID-01 | `packages/protocol/src/federation.test.ts`, `apps/web/src/lib/federation/federation-runtime.test.ts`, `apps/web/src/lib/desktop-storage-key.test.ts` |
| ID-02 | `apps/desktop/tests/connection-manager-federation.test.ts`, `apps/desktop/tests/ssh/ssh-route-fallback-integration.test.ts` (real OpenSSH) |
| ID-03, ID-04 | `apps/desktop/tests/connection-manager-federation.test.ts` |
| ID-05 | `apps/web/src/lib/federation/federation-runtime.test.ts` |
| RT-01 | `apps/desktop/tests/connection-manager-federation.test.ts`, `scripts/benchmark-federation.ts` |
| RT-02 | `apps/web/src/lib/federation/federation-runtime.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| RT-03 | `apps/desktop/tests/connection-manager-federation.test.ts`, `apps/web/src/lib/federation/federation-runtime.test.ts` |
| RT-04, RT-05, RT-06 | `apps/web/src/lib/federation/federation-runtime.test.ts` |
| OP-01 | `apps/desktop/tests/ssh/ssh-route-fallback-integration.test.ts` (real OpenSSH; lost write not resent after failover) |
| OP-02 | `apps/web/src/lib/federation/federation-runtime.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| OP-03 | `apps/desktop/tests/backend-terminal-input.test.ts` (fence survives a route retarget) |
| OP-05 | `apps/web/src/lib/federation/federation-runtime.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| OP-06 | `apps/desktop/tests/connection-manager-federation.test.ts`, `apps/desktop/tests/federation-ipc.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| UI-01 | `apps/web/src/lib/federation/aggregate.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| UI-02 | `apps/web/src/lib/federation/aggregate.test.ts` |
| UI-04 | `apps/web/src/lib/federation/federation-runtime.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| CL-01 | `apps/desktop/tests/connection-manager-federation.test.ts` |
| CL-02 | `apps/desktop/tests/connection-manager-federation.test.ts`, `apps/web/src/lib/desktop-storage-key.test.ts`, `apps/web/src/lib/federation/federation-runtime.test.ts` |
| CL-03 | `apps/web/src/lib/federation/aggregate.test.ts` |
| CL-04 | `apps/backend/src/core/backend-profile-store.test.ts`, `apps/web/src/components/settings/machines/MachinesSettings.test.tsx` |
| CL-05 | `apps/web/src/components/federation/federation-ui.test.tsx` |
| CT-02 | `apps/desktop/tests/connection-manager-federation.test.ts` |
| SH-01, SH-05, SH-06, SH-07, SH-10, SH-11 | `apps/desktop/tests/ssh/tunnel-supervisor.test.ts`, `apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts` (real sshd) |
| SH-02 | `apps/desktop/tests/ssh/host-trust.test.ts`, `apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts`, `apps/web/src/components/settings/machines/SshRouteDialog.test.tsx` |
| SH-03 | `apps/desktop/tests/ssh/tunnel-supervisor.test.ts`, `apps/desktop/tests/ssh/ssh-tunnel-integration.test.ts`, `apps/desktop/tests/federation-ipc.test.ts`, `apps/web/src/components/federation/federation-ui.test.tsx` |
| SH-04 | `apps/desktop/tests/ssh/ssh-proxyjump-integration.test.ts` (real sshd jump host) |
| SH-08, SH-09 | `apps/backend/tests/gateway-hello.test.ts`, `apps/desktop/tests/connection-manager-federation.test.ts` |
| SH-12 | `packages/protocol/src/device-catalogue.test.ts`, `apps/desktop/tests/ssh/ssh-command.test.ts`, `apps/desktop/tests/connection-manager-federation.test.ts` |
| SH-13 | `apps/desktop/tests/ssh/ssh-command.test.ts`, `apps/desktop/tests/ssh/tunnel-supervisor.test.ts` |
| SH-14 | `apps/desktop/tests/ssh/ssh-command.test.ts` (argv: `ControlMaster=no`, `ControlPath=none`) |
| AU-01, AU-02 | `apps/desktop/tests/connection-manager-federation.test.ts` |
| AU-03 | `apps/web/src/lib/federation/federation-runtime.test.ts` |
| WB-02 | `apps/desktop/tests/connection-manager-federation.test.ts` (client without SSH) |
| MG-01 | `packages/protocol/src/device-catalogue.test.ts`, `apps/desktop/tests/connection-manager-federation.test.ts`, `apps/web/src/lib/desktop-storage-key.test.ts` |
| MG-02, MG-04 | `apps/desktop/tests/connection-manager-federation.test.ts` |
| MG-03 | `apps/desktop/tests/connection-manager-federation.test.ts` (older backend stays provisional; no profile polling) |
| PF-01, PF-02, PF-03 | `apps/web/src/lib/federation/federation-runtime.test.ts`, `scripts/benchmark-federation.ts` |

Exercised live against two isolated standalone backends in a real browser
(Playwright), not as repository tests: WB-01 (direct sessions, panel frame
talks only to its machine), UI-05 (no navigation on filter or reconnect),
RT-01 offline/reconnect with colour kept, CL-01 colour edit converging via
the profile event, SH-08/SH-09 on a real loopback client gateway. Not
covered by tests: RT-07, OP-04 (approval arbitration is unchanged backend
behaviour), UI-03, UI-06, FS-01, FS-02, CT-01, CT-03 (covered at the time
by the realms' isolation by construction, now by per-node scope instances,
not by a dedicated test) and MB-01.
