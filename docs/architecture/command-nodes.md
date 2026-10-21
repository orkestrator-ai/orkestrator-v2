# Command nodes and leaf nodes

Status: **Target architecture (agreed 2026-10-21, not yet implemented).** This
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
as a leaf for it. There can be several command nodes. A client connects to
**one** command node at a time.

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
   credentials stored on the command node. Leaves do not need to know their
   command nodes.
5. **No silent cross-node side effects.** Creating projects on a leaf, moving
   secrets, and destructive actions on another node are explicit and
   approved. Ambiguous outcomes are reported, never blindly retried.

## Roles

| | Leaf node | Command node |
| --- | --- | --- |
| Runs projects, environments, agents | Yes | Yes |
| Registry of other nodes | No | Yes, stored in its backend |
| Serves the portal (multi-node UI) | No (its own single-node UI only) | Yes |
| Runs cross-node coordinators | No | Yes |
| Can be attached to a command node | Yes | Yes (acts as a leaf) |

- An Electron app connected to its own local backend is **always a command
  node**.
- A standalone backend (for example a VPS) is a leaf unless it is configured
  as a command node.
- When a command node is attached to another command node as a leaf, it
  exposes its **own** projects and environments. It does not re-export its
  own leaves to the parent (no transitive control by default).

## Clients

- A client connects to exactly one command node and sees one interface that
  covers that node and all of its connected nodes.
- Switching command nodes is a connection switch (the existing server
  switcher), not a merge. Clients keep only a short list of command nodes
  they can connect to; they do not keep a registry of leaves.
- Web and iOS always connect to a command node. A leaf's own single-node UI
  remains available for direct use.

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

## Coordinators

Coordinators run on command nodes. A coordinator can:

- **Create environments** — on its own node by default, or on a named
  connected node when asked.
- **Control environments on every connected node** — start, stop, prompt,
  answer within its permissions — including on command nodes acting as
  leaves.
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
  so after the user approves, with the location on the leaf stated
  explicitly in the approval.
- A project's gitignored files (for example `.env`) are never copied to a
  leaf implicitly. Transferring them is a separate, explicitly approved file
  transfer that names the files, and the values never appear in logs,
  receipts or transcripts.

## Security

- Leaf credentials live only on the command node's backend (encrypted at
  rest). Clients never receive them.
- Data-plane grants for direct streams are short-lived, scoped to one
  environment and one stream (one terminal session or one preview), and
  revocable; they are not the leaf's gateway token.
- A command node's authority over a leaf is the authority of the credential
  it holds; leaves still enforce their own approval and execution policies.
- Closing a connection, hiding a node or forgetting a node never stops
  remote work. Unknown outcomes after a lost connection are recorded against
  the owning node and never resubmitted automatically.

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

## Open decisions

These need confirmation before the corresponding phase is built:

1. Can one leaf be attached to several command nodes at the same time, and
   can it still be used directly (its own UI and coordinators) while
   attached? Assumed: yes to both, with the leaf arbitrating conflicts.
2. How does a standalone backend become a command node: a setting, a start
   flag, or both?
3. When a client cannot reach a leaf directly (for example iOS off the
   tailnet), is relaying terminals and previews through the command node
   acceptable? Assumed: yes, as a fallback.
4. Do agent chat and transcripts go through the command node (assumed), or
   also directly from the leaf?
5. Can a command node's access to a leaf be restricted (for example
   read-only, or no deletes), or is it always full control?
6. Which coordinator actions on leaves need user approval beyond project
   creation and secret transfer (for example deleting environments)?
7. Secret transfer: which files are eligible, does the approval cover one
   transfer or a standing rule, and are secrets kept on the leaf afterwards?
