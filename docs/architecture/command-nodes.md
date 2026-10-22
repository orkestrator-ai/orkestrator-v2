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
  Settings → Machines, or by opening a machine in a new window. Opening an
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
- **Handed down to leaves.** The command node sends the inherited subset
  of its settings (`@orkestrator/protocol/controller-settings`: agent
  defaults and models, review instruction, terminal, messaging and similar
  preferences) to each leaf when the link connects and whenever its config
  changes (`sync_controller_settings`, never routable through a workspace
  grant or `invoke_on_node`). The leaf lays them over its own config
  (`StorageConfig.loadConfig`), so a launch on the leaf that falls back to
  defaults — a coordinator's `launch_node_environment` without a model, a
  build or review step — uses the command node's.
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
- Machine-specific settings never travel: credentials and API keys, paths,
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
  node. A window whose workspace is on a leaf shows the same warning in
  place of the leaf's coordinator, with a link to the command node's
  coordinator for the same repository.
- When the node is no longer attached anywhere, it returns to being a
  command node and its coordinators regain their cross-node tools.

## Portal (aggregated interface)

- The command node keeps a live read model of every connected node's
  projects and environments (summaries, status, activity), fed by its own
  subscriptions to each node's event stream.
- Every resource is node-qualified (`{ nodeId, projectId }`,
  `{ nodeId, environmentId }`), so identical IDs on two nodes never collide.
  Commands from the portal carry the node reference and the command node
  routes them to the owner.
- Each environment shows its node's colour dot before its name. Unavailable
  nodes keep their last-known state, labelled, with writes disabled.

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
  messages: what to show (a project, an environment, the node's Add Project
  or New Environment dialog), the realm's own selection (for the sidebar's
  highlight), the sidebar's open state (the realm's toolbar toggles it),
  requests to open settings (they belong to the command node), and a ready
  handshake so nothing asked while a realm loads is lost.
- **Creating on another node** opens that node's New Environment dialog in
  its realm, so the node's defaults — the command node's inherited settings
  laid over its own — and start apply as they would there.
- **The title bar** shows the shown environment's name. The agent info and
  system usage, which describe the environment's agent and the machine it
  runs on, are shown at the end of the realm's toolbar.
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

## Projects on leaf nodes

- A coordinator never creates a project on a leaf without asking. It can do
  so after the user approves, with the location on the leaf stated in the
  approval.
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
