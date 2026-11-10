# Command nodes and leaf nodes

Status: **Agreed 2026-10-21 and built on this branch (milestones 1–4).** This
is the objective for multi-machine Orkestrator. It supersedes the
"independent backends, client-side federation" direction in
the earlier `docs/temp/remote.md` draft and the client-side design
described in [federation.md](federation.md). Where those documents conflict
with this one, this one wins. Open decisions are listed at the end. The build plan, contracts and the
requirement matrix with evidence are in
[command-nodes-plan.md](../development/command-nodes-plan.md); the short tour
is [command-nodes-handoff.md](../development/command-nodes-handoff.md).

## Summary

Every Orkestrator backend is a **node**. A node is either a **leaf** or a
**command node**:

- A **leaf node** runs its own projects, environments and agents. It keeps no
  registry of other machines.
- A **command node** is a node that also keeps, **in its backend**, a
  registry of the nodes it controls. It is the central control,
  coordination and registry point for them, and it serves the single
  interface (the "portal") that clients use.

A command node can itself be attached to another command node and then acts
as a leaf for it. There can be several command nodes, and a leaf can be attached to more than
one. A client connects to **one** target at a time: normally a command node,
or a leaf directly if the user chooses.

```text
              Electron / web / iOS  (thin clients; one command node at a time)
                         │  control plane (UI, commands, state, mail, files)
                         ▼
                 ┌───────────────┐
                 │ Command node A│  registry of nodes, coordinators, portal UI
                 └──┬─────┬──────┘
          dials out │     │ dials out
                    ▼     ▼
            ┌────────┐  ┌───────────────┐
            │ Leaf L1│  │ Command node B│  (acting as a leaf for A)
            └────────┘  └───────────────┘
                 ▲
                 │  data plane where reachable (terminal, preview streams)
       client ───┘  directly, authorised by a short-lived grant from A
```

## Principles

1. **Thin clients.** Electron, the hosted web client and iOS render what the
   command node serves and send explicit user intents. Aggregation, routing,
   identity, connection management and coordination live in the command
   node's backend, not in the frontend. The UI is served by the command node,
   so web and iOS pick up updates from it.
2. **Each node stays authoritative for its own work.** A leaf owns its
   environments, agent processes, approvals, files, Git operations and
   durable records. The command node controls and observes them; it does not
   take them over, copy their databases or migrate their work.
3. **The command node is the registry and the coordinator; the leaf talks
   to the user directly.** The command node knows every node, keeps the
   aggregated view, routes commands and coordinator messages, and runs file
   transfer. Interaction with a leaf environment — agent chat, terminals
   and web previews — goes **directly between the client and the leaf**
   whenever the client can reach it, authorised by a short-lived, narrowly
   scoped grant the command node obtains from the leaf. The command node can
   see that chat (it reads the leaf's transcripts) but does not sit in the
   middle of it. Relaying through the command node is the fallback when the
   client cannot reach the leaf, and the client shows which path is in use.
4. **The command node dials out.** It connects to each leaf over
   HTTPS/Tailscale or a managed SSH route, using the leaf's gateway
   credentials stored on the command node. A leaf records which command
   nodes are attached to it, but never needs to reach them.
5. **No silent cross-node side effects.** Creating projects on a leaf, moving
   secrets, and destructive actions on another node are explicit and
   approved. Ambiguous outcomes are reported, never blindly retried.

## Roles

There are exactly two levels: a command node and the nodes it commands.
There is no deeper hierarchy.

| | Leaf node | Command node |
| --- | --- | --- |
| Runs projects, environments, agents | Yes | Yes |
| Registry of subordinate nodes | No | Yes, stored in its backend |
| Serves the portal (multi-node UI) | No (its own single-node UI only) | Yes |
| Runs cross-node coordinators | No | Yes |
| Can be attached to a command node | Yes | Yes, and it then becomes a leaf |

- **What makes a command node is having subordinates.** Any node becomes a
  command node as soon as another node is registered under it. A setting
  exposes the ability to register nodes; an Electron app on its own local
  backend always has it, so the desktop is a command node whenever it
  commands anything (and is the natural command node by default).
- **A node is either commanding or subordinate, never both.** When a node
  that has its own subordinates is attached to another command node, it
  switches to **leaf mode**: it stops controlling its own subordinates and
  its coordinators stop acting as cross-node coordinators, because
  coordination belongs with the top-level command node (see
  [Leaf mode](#leaf-mode)). Its own projects,
  environments and agents keep running and are controlled by the command
  node above it. Its suspended registry is not exposed to the controller;
  the controller sees only that node's own projects and environments.
- **A leaf can have several command nodes.** It may be attached to more
  than one command node at once and still be used directly (its own UI) by
  connecting to it as the target. It keeps a record of the command nodes
  attached to it and which one contacted it most recently, and uses that to
  decide where updates that need a destination go (see
  [Updates from leaves](#updates-from-leaves)).
- A standalone backend (for example a VPS) is a leaf until it has
  subordinates of its own.

## Clients

- A client connects to exactly one target node at a time. Normally that is
  a command node, and the client sees one interface covering it and all of
  its subordinate nodes.
- A client can choose a leaf as its target instead and work with that leaf
  directly through the leaf's own single-node interface.
- Switching targets is a connection switch (the existing server switcher),
  not a merge. Clients keep only a short list of targets they can connect
  to; they never keep a registry of a command node's leaves.
- Web and iOS connect to a command node (or directly to a leaf) exactly as
  they connect to a backend today, and receive the UI from it.
- **The command node changes only when the user changes it**: with the
  switch on the "Command node" row of the sidebar's machines menu, in
  Settings → Machines, or by opening a machine in a new window. The switch
  hands command over (see [Handing command over](#handing-command-over)),
  so the machine chosen really becomes the command node. Opening an
  environment on another machine, or creating one there, shows that
  machine's workspace in the window's central region and never changes the
  window's command node. Saving a machine on a device
  (`connect` with `select: false`) does not switch to it on any client.

## Settings

Settings belong to the command node the client is connected to, and apply
to everything it runs, on every machine it controls.

- **In the client.** A leaf's view keeps the leaf's per-project repository
  settings and machine-specific globals. Only inherited preferences are
  overlaid from the command node (`layerConfig` in
  `lib/portal/command-node-config.ts`). Every read and save names its two
  nodes (`ConfigTargets`: the command node, and the machine or `null`), so
  layering never asks which renderer it runs in. A node scope's settings
  parent (`settingsParent`) supplies them: a leaf scope inherits from its
  window's command scope. Each scope's `configStore` holds that
  node's effective config (`effectiveConfig(scope)`), and a leaf's store
  re-lays the command scope's preferences whenever they change. Whole-global
  saves and patches send preference changes to the command node and
  machine-specific changes to the machine, preserving the other node's
  values (`runConfigCommand`, `runScopedConfigCommand`). Each settings
  section names the owner of its preferences and machine-specific controls.
- **Editing each machine.** With machines attached, the Settings header
  lists them (`SettingsMachineStrip`): the command node first, then each
  machine it controls, defaulting to the machine on screen. The choice is
  the sections' `useAccountMachine()` context; every call they make names it
  (`machineInvoke`: another machine's own scope while the window holds it
  warm or live and the command is a workspace one, otherwise `invoke_on_node`;
  relayed node events for live updates), and the general form reads and saves that machine's
  config through the same split as a leaf window (`invokeGlobalConfigCommand`
  with a `machine`), held apart from the window's own config store
  (`settings-config.tsx`). Sections only the command node has — Machines,
  Review, Messaging, the web client and Control MCP (its credentials are
  excluded from `invoke_on_node`) — keep the command node chosen.
- **Handed down to leaves.** The command node sends the inherited subset
  of its settings (`@orkestrator/protocol/controller-settings`: agent
  defaults and models, review instruction, terminal, messaging, Auto-steer and
  similar preferences) to each leaf when the link connects and whenever its config
  changes (`sync_controller_settings`, never routable through a workspace
  grant or `invoke_on_node`). The leaf lays them over its own config
  (`ConfigRepository.loadConfig`), so a launch on the leaf that falls back to
  defaults — a coordinator's `launch_environment` with a `nodeId` and no
  model, a build or review step — uses the command node's.
- **The leaf's own settings are kept underneath** (`loadOwnConfig`) and come
  back when the command node detaches. A whole-config save on the leaf that
  echoes an inherited value keeps the leaf's own; a changed value is stored
  as the leaf's own but stays overridden while the command node is attached.
  `get_node_status` reports which command node's settings are in use
  (`inheritedSettingsFrom`).
- With several command nodes attached, the leaf follows the one whose
  settings changed most recently; equal timestamps prefer the later receipt.
  Each snapshot is complete: omitted inherited keys use product defaults,
  while the leaf's persisted own values remain underneath.
- The automatic-account ticks (`agentAccountAutoSwitch`) travel like the other
  preferences, matching accounts by email, and each machine applies them to the
  accounts it has. Its logins, its active account, a pin left by a manual switch
  and the tick of an account with no email stay on the machine. An older leaf drops
  the key and keeps working; see
  [agent-accounts.md](agent-accounts.md#automatic-switching).
- Machine-specific settings never travel: credentials and API keys, paths
  (including the default projects folder a copied project is cloned into),
  installed or enabled platforms, container budgets, network policy,
  previews, MCP servers and logs.

## Node registry (on the command node)

- Stored in the command node's backend: node identity (installation ID),
  display profile (name, colour), routes (HTTPS/Tailscale and SSH), the
  leaf's gateway credential (in the backend's sensitive store, never sent to
  clients; OS-keychain encryption is a later hardening),
  route preference and enable/disable state.
- Every route is verified with the authenticated hello before use; identity
  mismatches and host-key or certificate failures are blocked, not bypassed
  by trying another route.
- SSH routes are run by the command node's backend using the host's OpenSSH
  (owned loopback forwards, host-key trust, no remote install). Interactive
  SSH prompts are relayed to the user through the portal; unattended
  reconnects use key/agent authentication only.
- The registry is managed from the portal's Machines settings. Removing a
  node from a registry only forgets it on that command node; it never stops
  or deletes anything on the node.

## Attachment

- A command node attaches a node by connecting to it with that node's
  gateway credential and registering itself on the node (its identity,
  display name and the time). The attached node records the attachment.
- While at least one command node is attached, the node is subordinate. If
  it has subordinates of its own, its command activity is suspended (not
  deleted) and resumes when it is no longer attached anywhere.
- Detaching happens when the command node removes the node from its
  registry, or when the user detaches it on the node itself. Neither stops
  the node's work.
- Attaching is refused if it would create more than two levels: a node that
  is currently subordinate cannot register subordinates, and a node cannot
  attach the command node that controls it.

## Handing command over

Choosing another machine as the command node makes it the command node, in
one step:

1. The command node in charge (the window's own, or, from a leaf's window,
   the command node controlling it) previews the handover
   (`preview_command_handover`): the machines it controls that the target
   does not, and whether it can follow as the target's leaf (it needs an
   HTTPS address and its gateway token, or a usable record already saved on
   the target).
2. If the target lacks machines, the client asks which to bring (all are
   chosen by default). On the desktop the list also offers machines saved
   only on this device; Electron main adds their tokens.
3. `hand_over_command` sends the chosen registry entries, with their
   credentials, and itself, to the target over its own link
   (`accept_command_handover`). The target registers them, then detaches
   every command node that controlled it, as if by the user there, so none
   re-attaches by itself. The old command node forgets the target and the
   machines it moved (each is told to detach), and becomes the target's
   leaf once the target attaches.
4. The window switches to the target and reloads in its multi-machine view.

The target can refuse the command node in charge, so the handover cannot use
its link. One cause is a loop: the target lists that command node among its
own machines, for example after it was added from the target's window. The
other is that the target's user detached it there. A refused link does not
retry, and the source cannot fix either record. On the desktop, Electron
main usually has its own connection to the target. It reads both records
there for the preview and passes the target's machines to
`preview_command_handover` (`targetNodeIds`), because the source's link cannot
read them. The dialog then always asks for confirmation and says what it will
clear. A connected target keeps its existing source record, including routes
and credentials saved only there. Otherwise, on confirm, Electron main removes
the source record that blocks attachment (`forget_node`) and allows a detached
source again (`allow_controller`), as needed. It resolves required credentials
before these writes. These repairs persist if a later step fails; the dialog
explains this before confirmation and the error reports it afterward. The
source then reconnects (`reconnect_node`) and hands over. The source becomes
the target's machine again through the handover itself if it has usable access.

Execution rechecks the previewed source and target identities, inspection
completeness, and exact repair set before writing. A changed plan returns to
confirmation. If either target read failed, the preview marks inspection as
incomplete, disables automatic execution, and cannot authorize repairs discovered
later. Without its own connection to the target, or from a browser, the
handover fails with the refusal's own message. A standalone source skips
handover only when its registry is empty; refused or pending machines still
need the full preview and confirmation flow.

Credentials travel only backend to backend (or from Electron main to a
backend), over the routes the command node already uses, and are stored in
the target's sensitive store. The commands are excluded from routing, grants
and the relay, so only a client holding the command node's gateway token
(the user) can start one. A target the command node does not control yet is
registered first with the token saved on the device. Handing command back
works the same way: the old command node clears its own record of having
detached the target before it hands over.

Before changing topology, the source checks the target's registry capacity;
the target repeats the check atomically with adoption. A shortage rejects the
whole handover. Machines already registered on both sides are cleaned up on
the source even when the client selects no additional machines. Their tokens
can fill a missing credential on the target.

The source persists a pending handover with a unique ID before removing the
target. It retains the authenticated transport until acceptance finishes,
including an SSH tunnel opened with an interactive password or passphrase.
The target persists adoption and an acceptance receipt together, then detaches
its controllers. Retrying the same ID resumes unfinished detach work or returns
the original counts. The target keeps the most recent 64 receipts. Lost
responses do not restore the old topology: the source retries immediately and
keeps unresolved work for its background retry loop and restart recovery.
Capacity and controller-authorization refusals restore the source's saved target
record and clear the uncommitted journal. Edits to existing machines and overlapping
handovers are refused while recovery is pending. Adding another machine remains
possible, but neither registration nor desktop migration can re-add the pending
target, whose registry slot remains reserved for rollback. Detach tombstones
continue retrying even when the source becomes a leaf.

SSH private-key file paths are local to the source and are omitted from
handover entries. The target may need its own SSH configuration. Independently
saved standalone machines with no fleet switch directly through the desktop
connection API. Native bridges without handover capabilities also keep their
native connection-switch flow.

## Updates from leaves

Every attached command node keeps its own subscription to the leaf's event
stream, so status, activity and environment changes reach all of them.
Updates that have a single destination are routed intelligently:

- A reply goes back to whoever sent the message it answers: a command
  node's coordinator through the outbox, a coordinator on the leaf itself
  locally.
- Mail to "the coordinator" and task completion reports go to the
  coordinator that last contacted that environment (launched it, delegated
  to it, started a workflow in it, prompted it or mailed it), whether that is
  one of the leaf's own coordinators or a command node's. An environment the
  leaf's own coordinator launched reports locally until a command node's
  coordinator contacts it, and back again once the local coordinator does
  (`LeafNodeMail.route`, `localCoordinatorContact`). A worker's report
  therefore always reaches the coordinator waiting on it: the 2026-10-26
  incident was three release workers' reports never reaching their local
  coordinator.
- With no coordinator contact at all, mail goes to the command node that
  contacted the leaf most recently, for its main coordinator of the
  repository, even when the project has a coordinator on the leaf:
  coordination happens on the command node, and the leaf's coordinator cannot
  act across nodes. A closed main there is reopened with the default agent.
- An agent names either end itself. `"local-coordinator"` reaches the
  coordinator on its own machine and is for when the user asks for that one;
  `"command-node-coordinator"` goes up even from a worker a local coordinator
  is working with. The `send_message` result names where it went.
- A command node with no coordinator for the repository hands an agent's mail
  back (`return_node_outbox_mail`), and the leaf's own coordinator receives it
  with a line saying why. With no coordinator there either, it stays in the
  outbox.
- If that command node is unreachable, the update waits in the leaf's
  outbox until a command node collects it; it is not dropped or sent to a
  different command node silently.
- The leaf's own main coordinator uses the same outbox. Its reply to a
  command node coordinator's mail goes back to that conversation; a new
  message to `"command-node-coordinator"` goes to the command node that last
  mailed this project's coordinator, else the most recent one, for its main
  coordinator of the repository (`LeafNodeMail.routeCoordinator`).

## Leaf mode

A command node attached to another command node operates in leaf mode:

- Its coordinators know they are in leaf mode. Their context says the node
  is subordinate to the named command node, and their cross-node tools
  (controlling other nodes, creating environments elsewhere, file transfer
  to other nodes) are unavailable. If one receives a message, it handles it
  as an agent on a leaf would — acting on its own node and replying — and
  does not start acting as a command node. It can still launch environments
  and workers on its own node. Its one cross-node action is mail to the
  command node's coordinator for the repository: a reply to that
  coordinator's request, or a new message to `"command-node-coordinator"`,
  both through the outbox, and its context tells it to hand on anything it
  cannot do itself this way rather than leave it stranded. Every other node
  tool still refuses.
- Notices for a repository's coordinator (status, pull request, automatic switch,
  usage-limit stop) go to the command node's main coordinator for that repository, not
  to its own, through the same outbox. It keeps the ones for repositories the command
  node lacks, those a command node too old to take them would miss, and those whose
  command node has been gone for an hour. Fallback claims the notice durably
  before delivery, excluding concurrent collection. Once collected, the command
  node owns delivery until it acknowledges or explicitly declines: a lost ack
  is ambiguous, so timeout or detach cannot safely send a second copy locally.
  Collected notices remain pending through silence, including outages longer than
  an hour, while that controller stays attached. A capability downgrade explicitly
  hands collected, deferred notices back to the leaf. Once the controller
  detaches, ambiguous collected notices are retired with `notice.collected-retired`
  rather than silently occupying the outbox or risking duplicate local delivery.
  A policy-parked notice (no open main and creation disallowed) stays queued but
  does not block the ordinary mail drain used to close worker delegations.
  A worker's close notice still reaches the
  coordinator that delegated to it. See
  [Who hears a notice](coordinator.md#who-hears-a-notice).
- Its coordinator conversations are kept, because they may hold important
  information, but they are mostly hidden: the portal and the node's own UI
  do not show them by default. They can be opened behind a warning that the
  node is in leaf mode and that coordination happens on the named command
  node ("the command node" when no controller name is known). Until the
  node's portal status has loaded, the coordinator tab shows only "Checking
  repository coordination…", so the coordinator neither flashes nor starts
  before the node's mode is known; a failed status read counts as loaded and
  opens the coordinator as on any other node. Opening it anyway is
  remembered per node and project for the rest of the app session
  (`openedLeafCoordinators` in the UI store, not persisted), so the warning
  returns after a restart.
- A leaf's workspace shown in a window follows the window's sidebar
  grouping. Grouped by repository, the window links each repository's
  projects across machines, so the leaf's coordinator is replaced by the
  same warning, with a link to the command node's coordinator for that
  repository; if the command node has no copy of it, the leaf's
  coordinator opens directly. Compact links them the same way and counts as
  repository grouping. Grouped by machine, project or activity, the machines
  are not linked and the leaf's coordinator opens directly. The leaf's
  workspace is in the window's own tree, so its coordinator gate
  (`LeafModeCoordinatorGate`) reads the grouping from the window's stores
  (`useWindowGrouping`, `coordinatorDefersToCommandNode` in
  `lib/federation/window-grouping.ts`).
- When the node is no longer attached anywhere, it returns to being a
  command node and its coordinators regain their cross-node tools.

## Portal (aggregated interface)

- The command node keeps a live read model of every connected node's
  projects and environments (summaries, status, activity), fed by its own
  subscriptions to each node's event stream. A subscription that receives
  nothing, not even the node's 25 s keepalive, for 75 s is reopened (a
  half-open route never errors on its own), and every connected node is
  re-read every 60 s by the named `node-summary-reconcile` activity due job as a last resort; a re-read that finds nothing new
  announces nothing.
- Summaries carry what the project search matches on, bounded and
  additive: a project's `repositoryHint`, its checkout directory's last
  segment (`pathName`, at most 128 characters, never the path) and its
  configured `defaultBranch`; an environment's branch, type, worktree
  directory name (`worktreeName`) and `createdAt`. The command node asks a
  node for default branches with `get_projects { includeDefaultBranch: true }`
  (never combined with a conditional read, since config changes do not move
  the project manifest). A node older than that ignores the argument and sends
  none; its rows match on what is present and "primary" falls back to `main`.
  Config resource changes trigger a summary re-read, so changed default branches
  appear without waiting for the next reconcile. The 60 s reconcile remains a
  fallback for missed events or changes made without an event.
- Every resource is node-qualified (`{ nodeId, projectId }`,
  `{ nodeId, environmentId }`), so identical IDs on two nodes never collide.
  Commands from the portal carry the node reference and the command node
  routes them to the owner.
- Each environment shows its node's colour dot before its name. Unavailable
  nodes keep their last-known state, labelled, with writes disabled.
- **Anything else on request.** The summaries stay small; a portal view that
  needs more of another node's state reads it and subscribes to it:
  - *Reads* go through `invoke_on_node` with the node's own command (for
    example `changes_get_view`, `get_environment`, `get_agent_registry`).
    `isNodeReadCommand` treats a read verb at the start of the name, or
    after one namespace (`changes_get_…`), as a read: it is never recorded
    as outcome-unknown and does not refresh the summaries. Reads that name
    their subject first (`graph_run_get`, `graph_template_get`, the code
    rewind previews) are listed by name, and so are the writes the verb rule
    would misread (`graph_describe_start`, `_cancel`, `_dismiss`), so the
    classifier agrees with each defined command's `read`
    ([7007](../../plans/unified/7007-domain-pipelines-graphs-multi-review.md)).
  - *Events* are relayed on request. A client leases a watch on a node for
    some event prefixes (`watch_node_events`, renewed every 30 s, expiring
    after 90 s; `unwatch_node_events`). The command node keeps one stream
    per watched node (`nodes/node-event-relay.ts`). Portal badge and hover
    events share a stable prefix superset so opening or closing a card does
    not reconnect the stream or resync unrelated views. Other prefix additions
    may expand the subscription; removals filter locally until the last watch
    leaves. Accumulated prefixes are bounded. The relay filters against the
    current watch union and re-emits each matching event as
    `relayed-node-event:<nodeId>` `{ nodeId, kind: "event", event, payload }`.
    A `{ nodeId, kind: "resync" }` frame (every stream open, every gap) means
    re-read what is shown from that node. Terminal output is never relayed.
  - *Relayed frames have their own replay window.* The gateway keeps them in
    a second ring (512 frames, 512 KiB; `relayedEventReplay`), with its own
    generation and revisions, so a busy leaf can only expire relayed cursors
    and never forces a client's main stream to reconcile. A renderer's main
    stream asks for none of them (`relayedEvents=per-node`) and reads them on
    one extra stream filtered to its watched nodes
    (`includeEvents=relayed-node-event:<nodeId>,…`,
    `@orkestrator/protocol/relayed-event-stream`). Changing the filter reopens
    that stream from its cursor, so nothing is lost and nothing re-reads. A gap
    the ring cannot cover reaches each watched node as a `resync` frame.
  - *The desktop's relay does the same for its windows.* A renderer that takes
    events through main (a window with `localWindowGatewayTransport` off)
    keeps its listeners in the preload, which
    tells main the per-node names it starts and stops listening to
    (`orkestrator:relayed-events:*`) and resets them when a new document loads.
    Main asks for none on its main stream and runs one filtered stream per
    connection (`BackendHttpClient.setRelayedEvents`) for the union of what the
    windows bound to that connection listen to
    (`DesktopWindowContexts.syncRelayedEvents`), and forwards a frame only to
    those windows. A window closing drops its listens, and a window
    moving to another connection takes them along. A window on the direct gateway
    transport adds nothing: it has its own stream.
  - *Older peers.* A stream that does not ask for per-node names, which is what
    an older renderer sends, gets each frame as `relayed-node-event` with no
    `id`, and is sent a `resync` for the nodes that relayed something since its
    cursor when it reconnects. An older command node answers `watch_node_events`
    with no `perNodeEvents` and sends only that name, which the renderer always
    listens for; main forwards it to every renderer on that connection. A desktop
    from before its main process took per-node events asks for the old name
    explicitly (`relayedEvents=legacy`). See the
    [register](version-compatibility.md#register).
  - In the renderer, `lib/federation/node-events.ts` holds one lease per
    node for every view and tells each view when to read (first after its
    subscription, then after any possible gap). The sidebar's change badge
    (`node-change-projections.ts`) and the environment hover card
    (`node-environment-reads.ts`) are built on it; the command node's own
    environments, shown from the window's full stores, subscribe directly
    (`subscribeCommandNodeEvents`).

## Opening an environment on another node

The window always stays on its command node. Its title bar, toolbar row,
sidebar, settings and background services are the command node's and never
reload. Clicking an environment (or a project) of another node shows that
node's workspace in the window's **central region**: the toolbar for the
environment, its tabs and panes, and the files panel. Only that region gets
its data from the other node; it runs this client's own code, served by the
command node.

That workspace renders in the window's own React tree, on the node's own
**node scope**, on desktop, browser and iOS: the same workspace components
the command node's own workspace uses, under a provider that names the
node ([federation.md](federation.md#node-scopes-one-scope-per-node-in-the-windows-tree),
[node-scopes.md](../development/node-scopes.md#a-nodes-workspace-in-the-windows-tree)).

- **A node scope.** The node's client, store instances, services and tier
  live in its own scope of the window (`NodeScope`, inside the window's
  `WindowScope`), so its state is never read for another node: ids are
  node-local, and each node has its own instances rather than shared,
  re-keyed stores. On the desktop main opens the window's scope on the node
  (`apps/desktop/electron/node-scopes.ts`, `node-ipc.ts`) and the renderer
  reaches it through `window.orkestrator.node(nodeId)`; in a browser or the
  iOS app the page's node-client registry
  (`lib/node-scope/node-clients.ts`) talks to the node's gateway. The
  command node is a scope too, the **command scope**, through which the
  window reaches the portal (registry, grants, layout, outcomes, handover).
  A lint boundary keeps multi-machine views off a node's workspace transport.
- **Opening** asks the command node for a workspace grant, direct first, then
  over the command node's own route. The desktop holds it in main for the
  window's node scope; a browser or iOS page holds it in its node client. It is
  renewed while the scope is open and revoked when it is released. Removing a
  grant, by any route or because it expired, closes the leaf's terminal sockets
  and event streams it authorized and refuses their queued terminal operations
  ([terminal transport](remote-gateway.md#compression-and-terminal-transport)).
- **Relayed event streams share one request.** Over plain HTTP/1.1 a browser
  holds at most six connections to the command node's origin, the window's
  own streams take four, and every relayed leaf's main event stream takes
  another. Once two or more relayed leaves shown in the window's own tree
  are warm at once, their main streams move onto one request,
  `GET /__orkestrator/nodes/events?nodes=a,b`
  (`nodes/node-event-multiplexer.ts`, `lib/node-scope/multiplexed-relay-stream.ts`,
  wire format in `@orkestrator/protocol/multiplexed-relay-events`; plan item
  5005). The command node opens one subscription per leaf with the cursor
  the client sent and forwards the leaf's frames unchanged, tagged with
  their node, so each node keeps the main stream's replay contract: a gap is
  that leaf's to replay or reconcile, and a leaf that drops is reopened from
  the last cursor forwarded. Each node needs a workspace the client opened
  for it on this command node; a node without one is refused and reads its
  own stream. At most 8 nodes per request and 32 requests per command node;
  leaf frames up to 8 MiB; a response holding more than 16 MiB is closed and
  every node resumes from its own cursor. An older command node answers 404,
  and the browser keeps one stream per leaf.
- **Switching** never reloads the window and never stops work on any node.
  Another environment of a node already held is a selection on that node's
  scope. A node switched away from stays **warm** (its main stream and light
  stores), is **suspended** after the host's idle time (15 minutes on the
  desktop, 5 in a browser, 2 on iOS: streams closed, cursor kept) and goes
  back to **summary** only under memory pressure, least recently shown first
  and never the shown node (plan item 4002), so going back to a node is
  instant or a resume from its cursor. A node opened again from summary, or
  after a restart, paints at once from a bounded local snapshot of its
  projects and environments, marked stale and read-only until the node's
  authoritative reads land (plan item 4003). Heavy data (transcripts,
  artifacts, images) is held in byte budgets shared by the whole window.
  Selecting one of the command node's own environments returns the central
  region to the window's own workspace, whose selection was cleared while
  another node's was shown.
- **Creating on another node** opens that node's New Environment dialog on
  its scope, so the node's defaults — the command node's inherited settings
  laid over its own — and start apply as they would there.
- **Project and environment menus** of another node offer what the node's
  own sidebar does. Dialogs (Repository Settings, Delete Project, an
  environment's Settings) open on the node's scope, so they read and write the
  node's own state and a project is deleted with its environments as there;
  Fork and Restart are routed commands; Open Repo on GitHub uses the
  project's repository hint; folders are arranged through the owner's
  sidebar layout.
- **The title bar** shows the shown environment's name, host meters and agent
  information trigger; for another node the meters are that node's
  (`useMachineSystemUsage(nodeId)`) and the popovers are ordinary ones with
  the node's data.
- **Native views** a node's workspace opens on the desktop (browser previews)
  are the node scope's own preview runtime in main, placed in window
  coordinates (`apps/desktop/electron/node-previews.ts`, plan item 2009).
- **The sidebar is symmetric.** The command node is listed from the window's
  full stores with the ordinary rows; every other node is listed from the
  command node's summaries, whatever its scope's tier. Both are drawn with the
  same row layout, so a row lines up the same whichever node owns it, and the
  row whose workspace the central region shows is the selected one, whichever
  node owns it.
- **The sidebar order is the command node's.** The command node keeps the
  cross-machine order every client shows (`get_portal_layout`,
  `update_portal_layout`, `portal-layout-changed`;
  `@orkestrator/protocol/portal-layout`): the machine order ("by machine"),
  the merged project order and the folders projects sit in there ("by
  project"), and the repository order ("by repository"). Which node the
  central region shows never moves anything. Until the user drags something, the
  command node comes first, then the other nodes in registry order; in the
  merged lists the command node's projects (with its folders) come first and
  every other node's follow. Anything new goes after whatever precedes it in
  that default. A node that is not connected is hidden from the merged lists
  but keeps its entries, so its projects return to their place. The machine
  order is also set by dragging rows in Settings > Machines, and the machine
  lists outside the sidebar follow it with the command node always first
  (`inMachineOrder`): that list, the Settings machine strip, the agent accounts
  table and the title bar's per-machine CPU readings
  (`MachineCpuReadings`, one coordinated read per machine, routed through the
  command node). Within a
  node's own section, project, folder and environment order belong to that
  node: a drag there is written to the owner (`arrange_projects`,
  `reorder_environments`), and moving a project into a folder of the merged
  list is recorded on the command node only.
- **Presentation.** Per-node state (layouts, drafts) is namespaced by node
  identity; window-level state (sidebar, zoom, and what is collapsed in the
  multi-machine sidebar, by machine-qualified key) stays with the window's own
  machine.
- **One intentional difference.** A workspace grant cannot perform a
  node's administrative commands (gateway token, web-client access, control
  MCP token, node registry); those stay in the command node's
  Settings → Nodes.
- **A node can be this computer.** When the command node is another machine
  and this computer is one of its leaves, this computer's own environments
  are still reached through a gateway. The renderer compares the node with
  this computer's installation ID (`localInstallationId`, from the desktop's
  main process) in `backendOnThisDevice(node)`. What launches a window on the
  backend's host (Open in VS Code or Cursor) follows
  `isBackendOnAnotherDevice(node)`; what depends on the route itself (loopback
  proxying, preview handoffs) keeps following `isRemoteGatewayConnection(node)`.

## Agent chat and the coordinator

An agent in a leaf environment has two separate conversations:

- **With the user, directly.** The client opens the environment's agent
  chat straight to the leaf (transcripts, streaming responses, prompts,
  approvals and questions), using a scoped grant from the command node. The
  leaf arbitrates its own approvals exactly as it does today.
- **With the coordinator, by message.** The two never share a chat.
  - When the agent needs to tell the coordinator something, it sends a
    message. The leaf routes it to the right command node (see
    [Updates from leaves](#updates-from-leaves)).
  - When the coordinator needs the agent, it either **reads directly** —
    a read-only link to the environment's transcripts, activity and state,
    to see what it is doing — or **sends it a message**. A message arrives
    as an ordinary incoming message: the agent processes it, which may
    change what it is doing and may lead it to send a message back.

The command node can see any leaf chat through the same read-only link, so
the portal can show attention (waiting, approvals) and coordinators can
follow progress, without relaying the conversation.

### Showing the connection path

The environment's info panel (the one that shows context, usage and runtime
details) shows how the client is connected to that environment: direct to
the leaf or relayed through the command node, the route in use (for example
Tailscale HTTPS or SSH via the command node), and the node it belongs to.

## Coordinators

Coordinators run on the top-level command node only. A coordinator can:

- **Create environments** — on the node the user names, otherwise on its own
  node unless load or OS gives a clear reason to use another connected node
  (`list_nodes` reports both; see
  [coordinator.md](coordinator.md#choosing-a-machine)).
- **Control environments on every connected node** — start, stop, prompt,
  answer — including on command nodes acting as leaves.
- **Delete environments only when the user asks.** A coordinator never
  deletes an environment on its own initiative. The user may ask for it in
  the coordinator chat; the deletion then goes through an explicit
  confirmation that names the node and the environment.
- **Message** agents in environments on every connected node, and receive
  their messages. Mail addresses are node-qualified; the command node
  delivers the coordinator's messages to the leaf and collects replies.
  With `toEnvironmentId: "coordinator"` it asks that node's main
  coordinator for the repository, which answers by mail
  ([coordinator.md](coordinator.md#coordinators-on-two-nodes)).
- **Interrogate** any environment on any connected node through a direct
  read-only link: status, activity, transcripts, diffs, files, test results.
- **Transfer files** to and from environments on connected nodes through a
  bounded, audited file-transfer framework (no content in logs).
- **Send a pasted image** to anyone it can message on any connected node, or
  copy one to an environment with `transfer_files`; see
  [Images between nodes](#images-between-nodes).

Coordinators keep their existing per-project ownership and read-only
boundary on their own checkout.

### One tool family, every node

Every environment and workflow tool of the coordinator's Control MCP takes
an optional `nodeId` and works on that node's copy of the project with the
same contract as on the command node: `get_launch_options` (that node's
agents, models, defaults and base branch tip), `list_environments`,
`get_environment`, `list_tabs`, `list_agents`, `get_tab_state`,
`get_tab_transcript`, `launch_environment`, `launch_job`,
`send_prompt_to_tab`, `send_message`, `start_environment`,
`stop_environment`, `get_repository_context`, the build pipeline tools,
the Multi Review tools (custom fix and reviewer tabs included) and the worker
surfaces `launch_terminal`, `open_worker_browser`, `edit_worker_tab`,
`create_pr`, `resolve_conflicts`, `get_worker_changes`, `fork_worker`,
`stop_worker_turn`, `list_worker_commands` and `run_worker_command` (see [coordinator.md](coordinator.md#worker-surfaces)), and the ticket tools
(`create_ticket`, `update_ticket`, `get_ticket`, `list_tickets`,
`add_ticket_comment`; see [Tickets across nodes](#tickets-across-nodes)). Without a `nodeId`, `list_environments` also lists
the project's environments on the other nodes. The older `*_node_*` tools
remain and use the same paths.

- **Authority stays on the command node.** Idempotency receipts, workflow
  associations and delegations are kept there with the resource's `nodeId`
  (`CoordinatorWorkflowAssociation.nodeId`); a reservation is written before
  the routed side effect and completed after it
  (`commands-registry-coordinator-nodes.ts`).
- **The node runs the work** through its ordinary commands and a few
  controller commands that reuse the button and local-coordinator logic
  with the node's own defaults and model catalogue
  (`commands-registry-controller-workflows.ts`).
- **Operator clients too.** An external Control MCP client and the
  `orkestrator` CLI reach the same leaves through public actions with a
  `nodeId` (`--node`), routed by the command node with the caller's
  authority relayed to the leaf; see
  [control-mcp.md](control-mcp.md#leaf-nodes).
- **Delegations and wakes behave as locally.** Mail across the node link is
  same-project coordinator mail (see
  [agent-messaging.md](agent-messaging.md#node-mail)): it wakes the worker,
  and the worker's report wakes the coordinator or is held while the
  coordinator waits on that worker. A remote delegation closes when the
  node shows the worker's turn has ended, or its environment failed,
  stopped or disappeared; build pipelines, Multi Reviews and pull requests
  the coordinator follows on a node send status wakes whose suggested calls
  carry the `nodeId`. A followed pull request is read from the node's
  `get_environment` and the PR monitor health its summaries relay (check
  counts, merge permission, `prMonitorConfirmed`), so "ready to merge" on a
  node needs its summaries to be current. The node's relayed
  `resource-changed` events (`environment` and `environment-pr-health`
  included) make this prompt; the maintenance sweep covers
  missed events, and an unreachable node changes nothing
  (`coordinator-remote.ts`, `nodes/node-coordinator-remote.ts`).

### Images between nodes

A coordinator's `send_message` with `attachments`
([coordinator.md](coordinator.md#passing-a-pasted-image-on)) works across a node
link in both directions, under the `node-mail-attachments` hello capability. A
batch of images waits in a private spool on each machine
(`<dataDir>/mail-attachment-spool/<batch>/`, the node file scope
`{ mailAttachments }`) and moves through the file-transfer framework, verified by
size and hash, with no content in a log or receipt.

- **Down (command node to leaf).** The command node reads and checks the images,
  and asks the leaf `prepare_node_mail_attachments` which it still needs. That
  also refuses a recipient that cannot take them (a stopped container, an
  environment with no workspace) before any bytes move. It transfers those, then
  calls `deliver_node_mail` with `attachments`. The leaf places the files
  (`place_node_mail_attachments`) before storing the mail. A failure at any step
  means no message, and the coordinator is told why.
- **Up (leaf to command node).** A command node reaches its leaves, never the
  reverse, so the leaf cannot push. The leaf's main coordinator copies the images
  into `outbox-<batch>` in its spool and queues the mail with their description
  (`OutboxItem.attachments`). When the command node collects its mail it fetches
  the files, places them in the destination conversation's attachment directory,
  and only then delivers and acknowledges. A failed fetch leaves the item queued
  for the next attempt. The spooled copy goes on acknowledgement. A retry after
  that is recognised (`acknowledgedAttachmentMail`, bounded), so it neither
  copies nor delivers again. Spooled images are capped at 256 MiB per command
  node; past that a new send is refused, never dropped.
- **Who may read a batch.** The scope is not a coordinator's: only the backend's
  own commands use it, and a coordinator's command invoker refuses
  `prepare_node_mail_attachments` and `place_node_mail_attachments`. Workspace
  grants exclude both.
- **A disconnected node is refused,** as for other node operations, before
  anything moves. A leaf with mail queued for a disconnected command node keeps
  it until that node next collects.
- **Older nodes.** A leaf without the capability is refused with "update that
  machine", counted as `node-mail-attachments.older-node`, because it would
  reject the unknown key or drop the images. A command node without it does not
  collect mail with images and cannot acknowledge it: the item stays queued until
  that node is updated. Its plain mail is unaffected.
- **Abandoned batches** (a process that stopped between staging and placing) are
  swept after a day; an `outbox-` batch never is, since it is the only copy.
  The same maintenance pass, which runs on every backend, removes images placed
  for a project home whose record is gone or that are past mail retention. Those
  are kept in `<dataDir>/project-home-mail-attachments/`, never in the user's
  checkout. A connected node's project home cannot be messaged, so they are only
  ever placed on the sender's own node.
  `transfer_files` follows the same path as the down direction, with the normal
  receipt and no mail.

`bun scripts/qa-coordinator-image-mail.ts` checks this on the real stack. It
starts a command node and a leaf from source, each with a temporary data
directory, an ephemeral loopback port, a private token and an isolated `HOME`,
and has the command node attach the leaf over its gateway. Each backend runs in
its own unprivileged user and mount namespace in which the other node's
directory is an empty tmpfs (`start(node, { hide })`), so the two share no
files, as on two machines: an image found on the other node got there over the
link. The script checks that blindness first. No agent runs: each
coordinator is created with no session and an image is pasted through
`write_coordinator_attachment`. It then checks that:

- a worker's agent tab on the same node, a side agent, a worker on the leaf and
  the leaf's coordinator each receive the image, and the leaf's coordinator's
  image reaches the command node's coordinator through the outbox;
- the leaf drops its outbox copy once the command node has collected the mail;
- `transfer_files` from attachments returns a completed receipt;
- a retry adds nothing, the copy is Git-excluded, and deleting the worker
  removes it;
- every refusal leaves no message: another conversation's file, traversal, a
  symlink, a non-image, too many images or too large an image, and a
  disconnected node.

The script shares its harness with `qa-command-nodes.ts`
(`scripts/qa-command-nodes-support.ts`). Both backends still share one kernel
and talk over loopback: a slow, SSH-forwarded or dropped link is not exercised.

That a recipient's agent can open what arrives is checked on the landing places
themselves, which are the same on every route
([coordinator.md](coordinator.md#passing-a-pasted-image-on)):
`coordinator-mail-attachments-read-live.test.ts` runs the pinned Claude and
Codex CLIs against a scripted loopback model.

## Tickets across nodes

A project's Kanban board is shared with every leaf that has a copy of the
same repository. The command node's board is authoritative and a leaf holds a
copy of each ticket under the same id; the full model (cursors, the leaf's
ticket outbox, conflicts, tombstones) is in
[tickets.md](tickets.md#sync-across-machines).

- **Direction.** The command node dials out here too: it sends the leaf the
  board's changes after the leaf's cursor, and collects the changes the leaf
  queued in its ticket outbox, exactly as it collects leaf mail. A leaf never
  reaches the command node.
- **When.** On every connect and stream resync, when the leaf announces queued
  changes (`ticket-sync-outbox-ready`), a moment after any change to a shared
  board here, and every 60 s.
- **Commands.** `apply_ticket_sync`, `get_ticket_sync_cursor`,
  `collect_ticket_sync_outbox` and `ack_ticket_sync_outbox` run only over the
  link of an attached command node; like the mail outbox they are never
  routable through `invoke_on_node`, a workspace grant or the relay.
  `get_ticket_sync_status` feeds the board's sync line, and
  `sync_node_tickets` syncs now.
- **Disconnection.** Ticket changes wait durably on both sides (the board
  itself, the leaf's outbox) and apply in order, once each, on reconnect.
  Launches and other changes to a disconnected node are refused, not queued;
  the coordinator that tried is woken once when the node reconnects
  (see [coordinator.md](coordinator.md#tickets-on-other-machines)).
- **Compatibility.** Gated on the `ticket-sync` capability. An older leaf is
  never sent tickets and the board says to update it; coordinator ticket
  tools work on that leaf's own board as before
  ([version-compatibility.md](version-compatibility.md)).
- **Several command nodes.** Each syncs its own board with the leaf. A ticket
  made on the leaf goes to the command node that synced that project last.
  When a command node detaches, the leaf keeps its copies as its own tickets.

## Usage readings across nodes

The newest plan-usage reading of each agent login (provider, email and
organisation) is shared the same way: the command node dials out, collects each
connected node's newest readings (`collect_shared_usage_readings`), keeps the
newest per login centrally and sends each node the readings of the logins it
has (`apply_shared_usage_readings`). It runs on every connect and stream resync,
when a node announces a reading it took (`agent-usage-readings-changed`), when
the command node takes one, and every 60 s. Both commands run only over the
link of an attached command node and are never routed. Only usage figures,
reset times, the plan, the reading time and the machine that took it travel,
never a credential. A node that predates the commands takes no part. The model
is in [agent-accounts.md](agent-accounts.md#shared-readings).

## Projects on leaf nodes

- **Copying a project to another machine.** Any project's menu offers
  "Copy to Machine…" for every machine the command node controls, in either
  direction (command node to leaf, leaf to command node, leaf to leaf). The
  copy is a fresh clone of the project's Git remote at the target's default
  projects folder (configurable per machine; otherwise where most of its
  projects are, else `~/Projects`), plus the untracked and ignored files the
  user ticks. `.env` files and the project's files to copy are ticked;
  dependency and build output (`node_modules`, `.venv`, `target`, `dist`, …)
  is listed but never ticked, because it is installed on each machine. The
  safe repository settings (branches, port mappings, files to copy, agent
  overrides) are copied too, and the ticked files can be added to the
  copy's files to copy. The source is never changed. The command node runs
  every copy (`nodes/node-project-copy.ts`): a background clone on the
  target, then bounded, batched file transfer that never replaces a file the
  target already has, so running a failed copy again finishes it.
- A coordinator never creates a project on a leaf without asking.
  `request_project_on_node` (with an optional location and suggested files)
  creates a request the user reviews in the same copy dialog, where the
  location and files are settled before approving; the outcome wakes the
  coordinator. `request_root_changes` uses the same request flow (kind
  `apply-root-changes`) for a worker on the coordinator's own node; see
  [coordinator.md](coordinator.md#worker-surfaces). So does
  `propose_agents_md_update` (kind `update-agents-md`): the request and its
  review stay on the command node, and with `nodeId` the section is read and
  the pull request opened on the leaf that owns that copy
  (`read_project_agents_md_section`, `open_project_agents_md_pr`, routed); see
  [coordinator.md](coordinator.md#saving-decisions-to-agentsmd). So does
  `answer_worker_question` (kind `answer-worker-question`): the request stays
  on the command node, and with `nodeId` the question is read from the leaf's
  worker tab and the approved answer sent through
  `answer_controller_worker_question`, a node-link-only command; see
  [coordinator.md](coordinator.md#worker-surfaces).
- Creating an environment on a leaf follows the same rules as creating a
  local environment today: a worktree (or container) is made from the
  project, then the project's `.env` files and other files selected in the
  project's settings are copied into it from the project root.
- On a leaf, those files come from the leaf's copy of the project root.
  Where the leaf's project has none (for example a project newly added from
  its git remote), they are copied from the command node's project root as
  part of environment setup, using the same per-project file selection.
- If both have a selected file, **the leaf's copy wins**.
- Setup commands a branch changes need approval on the machine that runs
  them; the approval panel can record it on every machine with the project
  ([setup-approval.md](setup-approval.md#several-machines)).
- File contents are never written to logs, receipts or transcripts.

### Comparing and updating project files across leaves

Coordinators get project-level tools for the project's `.env` and other
selected files across every node that has the project:

- **Compare:** for each node, which selected files exist and how they differ
  from the command node's copy — files missing or extra, and for `.env`
  files the keys added, removed or changed. Values are shown as "differs" or
  "same" (compared by fingerprint), not as plain text, so secrets do not
  enter the coordinator's model context or transcripts.
- **Update:** push the command node's version of chosen files (or chosen
  keys) to some or all nodes in one action. Content is copied node to node
  by the file-transfer framework without passing through the model, and the
  user approves the update, which lists the nodes and files.

## Security

- Leaf credentials live only on the command node's backend, in its
  sensitive store (0600, secure-delete database). Clients never receive
  them.
- A command node has **full control** of its leaves to begin with.
  Finer-grained permissions (for example read-only access) are a later
  addition.
- Data-plane grants for direct streams are short-lived, revocable and
  never the leaf's gateway token, and they cannot be used for
  administration (token rotation, attachment, grants, registry, the
  machine's global settings and credentials, rollout switches, desktop
  connections, installation-wide Docker limits and cleanup, host updates).
  The operator `public_action` entrypoint is refused in full: workspace
  renderers use the workspace commands, while public actions can also retry
  operations and dispatch to other nodes under operator authority. Grants do
  run the workspace: agent chat, terminals, previews, files, repository settings and
  the project boards. Grants and the relay run an **allow-list**: exactly
  the commands whose definition declares `access: "workspace"`
  (`admitsWorkspaceCommand`, `nodes/workspace-grant-scope.ts`; plan item
  7012). `admin` and `internal` commands, a command without a definition and
  an unknown name are refused (403), and a backend that cannot report a
  command's access refuses every command, so the list fails closed: a new
  command is refused through a grant until its definition says otherwise
  ([version-compatibility.md](version-compatibility.md#domain-contracts)).
  The relay applies the command node's own list, so a command a newer leaf
  added is refused through the relay (not through a direct grant, which the
  leaf checks) until the command node knows it. A refusal is not logged;
  with `nodes` at `debug`, a verdict the old deny-lists would have given
  differently logs `nodes grant.scope-disagreement` (no command name unless
  it is one of the fixed list in `workspace-grant-legacy-check.ts`), for one
  release. Settings reaches another machine's settings through
  `invoke_on_node` instead, which routes everything but
  `NODE_ROUTING_EXCLUDED_COMMANDS` (`nodes/node-routing.ts`). The
  first version is a workspace grant: one leaf, one controller and one client
  session. Narrowing to one environment and one stream (one terminal
  session, one preview, one download) is a later hardening.
- Leaves still enforce their own approval and execution policies.
- Closing a connection, hiding a node, detaching or forgetting a node never
  stops remote work. Unknown outcomes after a lost connection are recorded
  against the owning node and never resubmitted automatically.

## What carries over from the current branch

The client-side federation already on this branch is reworked into the
command node:

- **Reused as is:** node identities and references (`packages/protocol`
  `federation.ts`), machine profile and colours, the authenticated hello and
  endpoint roles, the loopback client gateway, outcome-unknown semantics,
  the colour dot and sidebar components, and the aggregation projections.
- **Moved into the command node backend:** the machine registry and route
  catalogue (today the desktop device catalogue), route verification,
  fallback and epochs (today `ConnectionManager`), the OpenSSH tunnel
  supervisor (today in Electron main), and the per-node read model (today
  renderer `BackendRuntime`s).
- **Reworked:** machine panels (a workspace bound to one leaf, talking to it
  directly) became a leaf's workspace in the window's central region, on the
  leaf's node scope: opening a leaf environment shows the leaf's workspace
  there while the window stays on its command node (see
  [Opening an environment on another node](#opening-an-environment-on-another-node)).
  It is authorised by scoped grants from the command node instead of
  credentials the client holds, and falls back to a relay through the command
  node when the leaf is unreachable. (History: for a while the whole window
  moved to the leaf and reloaded; that was replaced by workspace realms,
  separate documents per node, and those by node scopes in the window's own
  tree, plan items 6001-6003.)
- **Removed:** renderer-side multi-backend runtimes and registry, the
  client-owned machine catalogue (clients keep only their list of targets),
  and clients holding other nodes' gateway tokens.

## Delivery outline

Built in milestones with tested commits on one branch, reviewed as one PR.

1. **Registry, attachment and leaf mode** in the backend: node registry and
   routes (HTTPS and SSH from the backend), hello verification and
   fallback, attachment records on leaves, leaf mode, two-level rule,
   migration of saved desktop connections into the local registry.
2. **Portal:** aggregated read model and node-qualified command routing in
   the command node; one sidebar served to every client; leaf workspaces
   opened directly from the client with scoped grants and relay fallback;
   connection path in the info panel. Removal of the client-side
   federation runtime and catalogue.
3. **Cross-node coordinators:** environment placement (a named node, else its own unless load or OS says otherwise),
   messages to and from leaf agents with routing to the right command node,
   direct read access to leaf transcripts and state, deletion only on user
   request with confirmation.
4. **Files:** file-transfer framework, project creation on leaves with
   approval, environment file copying from the leaf's or the command node's
   project root, and `.env`/selected-file compare and update across leaves.

## Decided

| Topic | Decision |
| --- | --- |
| Leaf with several command nodes | Allowed. The leaf tracks attachments and the most recent contact and routes single-destination updates accordingly. Direct connection to a leaf stays possible. |
| What makes a command node | Having subordinate nodes registered. A setting exposes registration; the desktop always has it. |
| Agent chat | Direct between client and leaf; the command node can read it. Coordinator and agent communicate by message, or the coordinator reads the agent's transcript directly. |
| Fallback | Relaying through the command node is acceptable when the client cannot reach the leaf; the info panel shows the path in use. |
| Selected files on both | The leaf's copy wins; coordinators can compare and update project files across leaves. |
| Command node in leaf mode | Coordinators know they are in leaf mode and lose cross-node tools except mail to the command node's coordinator; their conversations stay accessible behind a warning. |
| Leaf permissions | Full control first; permissions later. |
| Deleting environments | Only on the user's request, which may come through coordinator chat, always with an explicit confirmation. |
| Files for leaf environments | Same as local environments: worktree or container, then `.env` and selected files copied from the project root (the leaf's, else the command node's). |
| Hierarchy | Two levels only. A command node attached to another becomes a leaf (leaf mode). |
| Dial direction | The command node dials out to its leaves. |
| Projects on leaves | Created only with user approval and an explicit location. |
| Existing saved desktop connections | On upgrade they are attached as leaves of the desktop's local command node. A saved machine that commands its own leaves switches to leaf mode when attached. |
| `.env` values for coordinators | Fingerprint-level differences only by default; plain text only on an explicit user request in that conversation. |
| Leaf origins | Attaching registers the command node's portal origin on the leaf, so clients can reach the leaf directly with scoped grants. |

## Open decisions

None at present.
