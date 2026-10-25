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

- **In the client.** A leaf window keeps the leaf's per-project repository
  settings and machine-specific globals. Only inherited preferences are
  overlaid from the command node over the portal channel
  (`lib/portal/command-node-config.ts`). Whole-global saves send preference
  changes to the command node and machine-specific changes to the workspace
  backend, preserving the other node's values. Each settings section names
  the owner of its preferences and machine-specific controls.
- **Editing each machine.** With machines attached, the Settings header
  lists them (`SettingsMachineStrip`): the command node first, then each
  machine it controls, defaulting to the machine on screen. The choice is
  the sections' `useAccountMachine()` context; every call they make names it
  (`machineInvoke`, `invoke_on_node` for another machine, relayed node events
  for live updates), and the general form reads and saves that machine's
  config through the same split as a leaf window (`invokeGlobalConfigCommand`
  with a `machine`), held apart from the window's own config store
  (`settings-config.tsx`). Sections only the command node has — Machines,
  Review, Messaging, the web client and Control MCP (its credentials are
  excluded from `invoke_on_node`) — keep the command node chosen.
- **Handed down to leaves.** The command node sends the inherited subset
  of its settings (`@orkestrator/protocol/controller-settings`: agent
  defaults and models, review instruction, terminal, messaging and similar
  preferences) to each leaf when the link connects and whenever its config
  changes (`sync_controller_settings`, never routable through a workspace
  grant or `invoke_on_node`). The leaf lays them over its own config
  (`StorageConfig.loadConfig`), so a launch on the leaf that falls back to
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

- Mail from a leaf environment's agent to "the coordinator", answers to a
  coordinator's request, and task completion reports go to the command node
  that started that conversation or task (recorded when it was started).
- When there is no originating command node, they go to the command node
  that contacted the leaf most recently.
- If that command node is unreachable, the update waits in the leaf's
  outbox until a command node collects it; it is not dropped or sent to a
  different command node silently.

## Leaf mode

A command node attached to another command node operates in leaf mode:

- Its coordinators know they are in leaf mode. Their context says the node
  is subordinate to the named command node, and their cross-node tools
  (controlling other nodes, creating environments elsewhere, file transfer
  to other nodes) are unavailable. If one receives a message, it handles it
  as an agent on a leaf would — acting on its own node and replying — and
  does not start acting as a command node.
- Its coordinator conversations are kept, because they may hold important
  information, but they are mostly hidden: the portal and the node's own UI
  do not show them by default. They can be opened behind a warning that the
  node is in leaf mode and that coordination happens on the named command
  node.
- A window whose workspace is on a leaf follows its sidebar grouping.
  Grouped by repository, the window links each repository's projects
  across machines, so the leaf's coordinator is replaced by the same
  warning, with a link to the command node's coordinator for that
  repository; if the command node has no copy of it, the leaf's
  coordinator opens directly. Grouped by machine or project, the machines
  are not linked and the leaf's coordinator opens directly. The window
  sends its grouping to the realm (`grouping` message,
  `realmCoordinatorDefers`), since a realm cannot read the window's
  storage.
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
    as outcome-unknown and does not refresh the summaries.
  - *Events* are relayed on request. A client leases a watch on a node for
    some event prefixes (`watch_node_events`, renewed every 30 s, expiring
    after 90 s; `unwatch_node_events`). The command node keeps one stream
    per watched node (`nodes/node-event-relay.ts`). Portal badge and hover
    events share a stable prefix superset so opening or closing a card does
    not reconnect the stream or resync unrelated views. Other prefix additions
    may expand the subscription; removals filter locally until the last watch
    leaves. Accumulated prefixes are bounded. The relay filters against the
    current watch union and re-emits each matching event as
    `relayed-node-event` `{ nodeId, kind: "event", event, payload }`. A
    `{ nodeId, kind: "resync" }` frame (every stream open, every gap) means
    re-read what is shown from that node. Terminal output is never relayed.
  - In the renderer, `lib/federation/node-events.ts` holds one lease per
    node for every view and tells each view when to read (first after its
    subscription, then after any possible gap). The sidebar's change badge
    (`node-change-projections.ts`) and the environment hover card
    (`node-environment-reads.ts`) are built on it; the command node's own
    environments, shown from its self summary, subscribe directly.

## Opening an environment on another node

The window always stays on its command node. Its title bar, toolbar row,
sidebar, settings and background services are the command node's and never
reload. Clicking an environment (or a project) of another node shows that
node's workspace in the window's **central region**: the toolbar for the
environment, its tabs and panes, and the files panel. Only that region gets
its data from the other node; it runs this client's own code, served by the
command node.

- **Workspace realms.** The central region of another node is a *realm*: a
  separate renderer of this client bound to that node's workspace and to
  nothing else (`lib/federation/workspace-realm.ts`). On the desktop it is a
  child view of the window with its own connection scope
  (`apps/desktop/electron/workspace-views.ts`); in a browser or the iOS app it
  is a same-origin frame of the page the command node served. Its stores,
  events and credentials therefore reach only that node, by construction.
  The realm shows no title bar or sidebar of its own.
- **Two channels per realm.** The realm's *workspace* transport
  (`window.orkestrator`) is bound to its node. Its *portal* channel
  (`window.orkestratorPortal`, used through `lib/portal/portal-transport.ts`)
  stays on the window's command node, for what a workspace needs from it
  (the command node's inherited settings, coordinator links). A lint
  boundary keeps multi-machine views off the workspace transport.
- **Opening** asks the command node for a workspace grant. The desktop binds
  the realm's scope in its main process (direct first, then the command
  node's own route); a browser or iOS window keeps the grant in its tab's
  session storage under the workspace's ID, which is all the frame's URL
  carries, and the frame boots its gateway against the node (direct first,
  then the relay). The window renews the grant while the realm is open and
  revokes it when the realm closes.
- **Switching** never reloads the window. Another environment of a node whose
  realm is open is a message to that realm and an instant selection there.
  The window keeps a few realms open, hidden (`MAX_OPEN_REALMS`), so going
  back to a node is instant too. Selecting one of the command node's own
  environments returns the central region to the window's own workspace,
  whose selection was cleared while another node's was shown.
- **What crosses between a window and its realm** is a handful of bounded
  messages: what to show (a project, an environment, or one of the node's
  dialogs: Add Project, New Environment, Repository Settings, Delete Project
  or an environment's Settings), the realm's own selection (for the sidebar's
  highlight), the sidebar's open state (the realm's toolbar toggles it),
  requests to open settings (they belong to the command node), and a ready
  handshake so nothing asked while a realm loads is lost.
- **Creating on another node** opens that node's New Environment dialog in
  its realm, so the node's defaults — the command node's inherited settings
  laid over its own — and start apply as they would there.
- **Project and environment menus** of another node offer what the node's
  own sidebar does. Dialogs (Repository Settings, Delete Project, an
  environment's Settings) open in the node's realm, so they read and write the
  node's own state and a project is deleted with its environments as there;
  Fork and Restart are routed commands; Open Repo on GitHub uses the
  project's repository hint; folders are arranged through the owner's
  sidebar layout.
- **The title bar** shows the shown environment's name, host meters and agent
  information trigger. For another node, the realm reports the readings and
  renders the popovers under those triggers. The latest panel request waits
  for readiness; Escape, outside presses and leaving the realm also cancel
  pending opens. Sequence acknowledgments prevent late reports from reviving
  dismissed panels. Opening transfers focus into the realm; a user dismissal
  returns it to the corresponding title-bar trigger. Workspace switches and
  panel replacements do not request return focus.
- **Native views** a realm opens (browser previews, live artifacts) are
  children of the window placed in the realm's coordinates, and shown only
  while the realm is (`realmChildViewClass`). The window hides a realm while
  one of its own dialogs or menus is open, as it does for previews.
- **The sidebar is symmetric.** The command node is listed from the window's
  full stores with the ordinary rows; every other node is listed from the
  portal's summaries. Both are drawn with the same row layout, so a row lines
  up the same whichever node owns it, and the row whose workspace the central
  region shows is the selected one, whichever node owns it.
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
  but keeps its entries, so its projects return to their place. Within a
  node's own section, project, folder and environment order belong to that
  node: a drag there is written to the owner (`arrange_projects`,
  `reorder_environments`), and moving a project into a folder of the merged
  list is recorded on the command node only.
- **Presentation.** Per-node state (layouts) is namespaced by node identity;
  window-level state (sidebar, zoom, and what is collapsed in the
  multi-machine sidebar, by machine-qualified key) stays with the window's own
  machine. A realm's presentation state (layouts, drafts) is namespaced by its
  node.
- **One intentional difference.** A workspace grant cannot perform a
  node's administrative commands (gateway token, web-client access, control
  MCP token, node registry); those stay in the command node's
  Settings → Nodes.

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

- **Create environments** — on its own node by default, or on a named
  connected node when asked.
- **Control environments on every connected node** — start, stop, prompt,
  answer — including on command nodes acting as leaves.
- **Delete environments only when the user asks.** A coordinator never
  deletes an environment on its own initiative. The user may ask for it in
  the coordinator chat; the deletion then goes through an explicit
  confirmation that names the node and the environment.
- **Message** agents in environments on every connected node, and receive
  their messages. Mail addresses are node-qualified; the command node
  delivers the coordinator's messages to the leaf and collects replies.
- **Interrogate** any environment on any connected node through a direct
  read-only link: status, activity, transcripts, diffs, files, test results.
- **Transfer files** to and from environments on connected nodes through a
  bounded, audited file-transfer framework (no content in logs).

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
`stop_environment`, `get_repository_context`, the build pipeline tools and
the Multi Review tools. Without a `nodeId`, `list_environments` also lists
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
- **Delegations and wakes behave as locally.** Mail across the node link is
  same-project coordinator mail (see
  [agent-messaging.md](agent-messaging.md#node-mail)): it wakes the worker,
  and the worker's report wakes the coordinator or is held while the
  coordinator waits on that worker. A remote delegation closes when the
  node shows the worker's turn has ended, or its environment failed,
  stopped or disappeared; build pipelines and Multi Reviews on a node send
  status wakes whose suggested calls carry the `nodeId`. The node's relayed
  `resource-changed` events make this prompt; the maintenance sweep covers
  missed events, and an unreachable node changes nothing
  (`coordinator-remote.ts`, `nodes/node-coordinator-remote.ts`).

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
  coordinator.
- Creating an environment on a leaf follows the same rules as creating a
  local environment today: a worktree (or container) is made from the
  project, then the project's `.env` files and other files selected in the
  project's settings are copied into it from the project root.
- On a leaf, those files come from the leaf's copy of the project root.
  Where the leaf's project has none (for example a project newly added from
  its git remote), they are copied from the command node's project root as
  part of environment setup, using the same per-project file selection.
- If both have a selected file, **the leaf's copy wins**.
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
  administration (token rotation, attachment, grants, registry). The first
  version is a workspace grant: one leaf, one controller and one client
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
  directly) became workspace realms in the window's central region: opening
  a leaf environment shows the leaf's workspace there while the window stays
  on its command node (see
  [Opening an environment on another node](#opening-an-environment-on-another-node)).
  They are authorised by scoped grants from the command node instead of
  credentials the client holds, and fall back to a relay through the command
  node when the leaf is unreachable. (For a while the whole window moved to
  the leaf and reloaded; that was replaced by realms.)
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
3. **Cross-node coordinators:** environment placement (own node by default),
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
| Command node in leaf mode | Coordinators know they are in leaf mode and lose cross-node tools; their conversations stay accessible behind a warning. |
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
