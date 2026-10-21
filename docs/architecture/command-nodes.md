# Command nodes and leaf nodes

Status: **Target architecture (agreed 2026-10-21, decisions refined the same day; not yet implemented).** This
is the objective for multi-machine Orkestrator. It supersedes the
"independent backends, client-side federation" direction in
[`docs/temp/remote.md`](../temp/remote.md) and the client-side design
described in [federation.md](federation.md). Where those documents conflict
with this one, this one wins. Open decisions are listed at the end.

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
3. **Control plane through the command node; data plane direct where
   possible.** Commands, state, events, coordinator traffic, mail and file
   transfer go through the command node. High-bandwidth interactive streams
   (terminals, web previews) go **directly from the leaf to the client**
   whenever the client can reach the leaf, authorised by a short-lived,
   narrowly scoped grant the command node obtains from the leaf. Relaying a
   stream through the command node is the fallback when the client cannot
   reach the leaf.
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
  becomes a leaf: it suspends its command activity (stops controlling its
  own subordinates and stops its cross-node coordinator activity), because
  coordination belongs with the top-level command node. Its own projects,
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

## Node registry (on the command node)

- Stored in the command node's backend: node identity (installation ID),
  display profile (name, colour), routes (HTTPS/Tailscale and SSH), the
  leaf's gateway credential (encrypted at rest with the host's secret store),
  route preference and enable/disable state.
- Every route is verified with the authenticated hello before use; identity
  mismatches and host-key or certificate failures are blocked, not bypassed
  by trying another route.
- SSH routes are run by the command node's backend using the host's OpenSSH
  (owned loopback forwards, host-key trust, no remote install). Interactive
  SSH prompts are relayed to the user through the portal; unattended
  reconnects use key/agent authentication only.
- The registry is managed from the portal's Connections settings. Removing a
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

## Agent chat through the command node

Agent chat (transcripts, streaming responses, prompts, approvals and
questions) goes through the command node, not directly from the leaf:

- It is control traffic, not bulk data: structured, moderate in volume and
  already bounded by transcript windows and paging.
- The command node must see it anyway: it aggregates attention (waiting,
  approvals), routes mail between coordinators and agents, and enforces
  approval rules. One path keeps approvals arbitrated in one place and
  avoids a second, divergent client connection to the leaf.
- The added hop is small on a tailnet compared with model latency.

Large binary content attached to chat (images, artifact files, downloads)
can use the direct data path with a scoped grant, like terminals and
previews, so it does not pass through the command node.

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
- **Send and receive mail** with agents in environments on every connected
  node. Mail addresses are node-qualified; the command node routes mail to
  and from leaves.
- **Interrogate** any environment on any connected node: status, activity,
  transcripts, diffs, files, test results.
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
- File contents are never written to logs, receipts or transcripts.

## Security

- Leaf credentials live only on the command node's backend (encrypted at
  rest). Clients never receive them.
- A command node has **full control** of its leaves to begin with.
  Finer-grained permissions (for example read-only access) are a later
  addition.
- Data-plane grants for direct streams are short-lived, scoped to one
  environment and one stream (one terminal session, one preview, one
  download), and revocable; they are not the leaf's gateway token.
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
- **Removed:** renderer-side multi-backend runtimes and registry, panels as
  separate renderer realms, hosted-browser direct machine sessions, and the
  client-owned machine catalogue (clients keep only their list of command
  nodes).

## Delivery outline

1. Contracts: node roles, node-qualified references, registry schema, portal
   API, data-plane grant, cross-node mail addressing, file-transfer API.
2. Registry and connections in the command node backend (HTTPS and SSH),
   with health, identity verification and route fallback.
3. Aggregated read model, node-qualified command routing and event fan-in.
4. Portal UI on the existing single-backend client, with node dots,
   grouping and node-aware actions.
5. Data plane: direct terminal and preview streams with scoped grants, relay
   fallback.
6. Cross-node coordinators: environment placement, control, interrogation,
   mail routing.
7. File transfer, and approved project creation and secret transfer on
   leaves.
8. Nested command nodes, several command nodes per leaf, migration from the
   client-side federation, removal of the client-side code.

## Decided

| Topic | Decision |
| --- | --- |
| Leaf with several command nodes | Allowed. The leaf tracks attachments and the most recent contact and routes single-destination updates accordingly. Direct connection to a leaf stays possible. |
| What makes a command node | Having subordinate nodes registered. A setting exposes registration; the desktop always has it. |
| Agent chat | Through the command node; large binary attachments may use the direct data path. |
| Leaf permissions | Full control first; permissions later. |
| Deleting environments | Only on the user's request, which may come through coordinator chat, always with an explicit confirmation. |
| Files for leaf environments | Same as local environments: worktree or container, then `.env` and selected files copied from the project root (the leaf's, else the command node's). |
| Hierarchy | Two levels only. A command node attached to another becomes a leaf and suspends its command and coordinator activity. |
| Dial direction | The command node dials out to its leaves. |
| Projects on leaves | Created only with user approval and an explicit location. |

## Open decisions

1. When a client cannot reach a leaf directly (for example iOS off the
   tailnet), is relaying terminals and previews through the command node an
   acceptable fallback? Assumed: yes.
2. If both the leaf's project root and the command node's project root have
   a selected file, which copy wins? Assumed: the leaf's.
3. What should the user see on a node whose command activity is suspended
   because it was attached to another command node, and should its own
   coordinator conversations be paused or left read-only?

