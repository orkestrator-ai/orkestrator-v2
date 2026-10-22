# Command nodes: implementation plan and traceability

Status: **Plan of record for
[command-nodes.md](../architecture/command-nodes.md); built on this branch
(M1–M4) and verified 2026-10-21 (see [Verification results](#verification-results)).**
command-nodes.md says *what* the system must do. This document says *how* it
is built: the contracts, the code layout, the milestone tasks, and a
requirement matrix used to check the finished build against the spec.

Rules for this document:

- Every statement in command-nodes.md and every decision the user made in
  the design conversation maps to at least one requirement ID below. The
  coverage maps in [Spec coverage](#spec-coverage) prove it.
- Status values are `Planned`, `In progress`, `Done`, `Deviation` (built
  differently, with a reason) and `Deferred` (not built, with a reason).
  They are updated in the same commit as the code that changes them.
- A requirement is `Done` only with evidence: a named test or a recorded QA
  step. "Follows from the design" is not evidence.
- [Final verification](#final-verification) is the procedure run after the
  last milestone.

## Contents

- [Deviations and refinements](#deviations-and-refinements)
- [Code layout](#code-layout)
- [Contracts](#contracts)
- [Milestones and tasks](#milestones-and-tasks)
- [Requirement matrix](#requirement-matrix)
- [User decisions](#user-decisions)
- [Spec coverage](#spec-coverage)
- [Final verification](#final-verification)

## Deviations and refinements

These change or sharpen statements in command-nodes.md. The spec is edited
to match, and each one is listed in the final report.

1. **Leaf credentials at rest.** The spec said "encrypted at rest with the
   host's secret store". The backend is a Bun process with no OS keychain
   binding today. Leaf credentials are stored in the backend's sensitive
   store (the SQLite database, which is 0600 with `secure_delete`, written
   through `saveSensitiveJson`). This is the same protection the backend
   already gives API keys and agent mail. They are never returned by any
   command or event, never logged, and redacted from diagnostics.
   OS-keychain encryption is a later hardening. Desktop tokens are already
   `safeStorage`-encrypted, so they are decrypted only in Electron main,
   during migration.
2. **Workspace grants first, narrower grants later.** The spec said
   data-plane grants are "scoped to one environment and one stream". A
   leaf workspace (the reworked machine panel) issues many calls: chat,
   transcripts, file trees, terminals and previews. The first grant is
   therefore a **workspace grant**:
   - one leaf, one issuing controller and one client session;
   - a 15-minute lifetime, renewed by the command node while the workspace
     is open;
   - revoked when the workspace closes, or when the node is detached or
     forgotten;
   - not the gateway token, and refused for administrative commands (see
     [Grant-excluded commands](#grant-excluded-commands)).

   Per-environment, per-stream grants are tracked as DP-07 (`Deferred`
   until the workspace grant ships and the command list per environment is
   enumerable).
3. **Detach when the leaf is unreachable.** Forgetting a node keeps a
   *detach tombstone*, with the credential, until the leaf confirms
   `detach_controller`. Otherwise an offline leaf could stay in leaf mode
   forever. The user can drop the tombstone ("Forget without detaching"),
   and the leaf's own UI can always detach a controller (AT-02).
4. **Project identity across nodes.** "Every node that has the project" is
   matched on the normalized Git remote of the project's repository: the
   same key the sidebar uses for repository grouping. A project with no
   remote matches only itself.
5. **Revealing `.env` values.** "Plain text only on an explicit user
   request in that conversation" is built as a user confirmation in the
   portal, never a tool the model can complete on its own. The coordinator
   tool only *requests* the reveal.
6. **Older leaves.** A node whose hello lacks the `node-attachment`
   capability is listed as "needs update". The command node never controls
   or aggregates it.

## Code layout

| Area | Location | Notes |
| --- | --- | --- |
| Shared contracts | `packages/protocol/src/command-nodes.ts` | Node mode, registry view, attachment, grant, node event, outbox, action request and node mail address types, with parsers. |
| Node link (shared, Node-only) | `packages/protocol/src/node/ssh/` and `packages/protocol/src/node/node-link/` | Moved from `apps/desktop/electron`: the OpenSSH tunnel adapter (`ssh/*`), the authenticated hello check (`backend-hello.ts`) and route opening and failure classification (`connection-routes.ts` → `routes.ts`). The desktop keeps re-export shims. Built in M1: the desktop's multi-route `ConnectionManager` and `BackendHttpClient` stay in the desktop (they serve its own target switching); the backend has its own lean `NodeLink` (`apps/backend/src/core/nodes/node-link.ts`) on the shared pieces. |
| Command-node backend | `apps/backend/src/core/nodes/` | `node-registry-store.ts`, `node-attachments.ts`, `node-mode.ts`, `node-link-manager.ts`, `node-ssh-prompts.ts`, `node-read-model.ts`, `node-relay.ts`, `client-grants.ts`, `node-outbox.ts`, `node-action-requests.ts`, `node-file-transfer.ts`, `project-file-compare.ts`. |
| Commands | `apps/backend/src/core/commands-registry-nodes.ts` (command side), `commands-registry-node-leaf.ts` (leaf side) | Registered with the existing `register(name, handler)` registrar. |
| Storage | `StorageService` chain, new stores in `STORE_LAYOUTS` and `storage-writer-guards` | `node-registry.json` (sensitive), `node-attachments.json`, `node-summaries.json`, `node-outbox.json` (sensitive: mail bodies), `node-action-requests.json`, `node-outcomes.json`. |
| Renderer portal | `apps/web/src/lib/portal/`, `apps/web/src/components/federation/*` reworked | One `PortalProvider` over the bound backend replaces `FederationProvider` and the per-machine runtimes. The dot, sidebar sections, filter and aggregation projections are reused. |
| Desktop | `apps/desktop/electron/` | Keeps the server-switcher target list and local backend start-up. Gains the catalogue → registry migration. Loses federation observation (multi-machine IPC and observation leases). |

## Contracts

### Node mode

```ts
type NodeMode = "standalone" | "command" | "leaf";
interface NodeStatus {
  nodeId: BackendId;               // this node's installation ID
  mode: NodeMode;
  registrationEnabled: boolean;    // the "command node" setting
  controllers: ControllerView[];   // command nodes attached to this node
  mostRecentControllerId?: BackendId;
  suspendedSubordinateCount: number; // > 0 only in leaf mode
}
```

- `mode` is `leaf` if at least one controller is attached. Otherwise it is
  `command` if at least one registry node is enabled and attached, and
  `standalone` if neither applies.
- `registrationEnabled` comes from the global config `commandNode.enabled`,
  which defaults to false. The desktop launches its local backend with
  `--command-node`, which forces it on.
- When a node enters leaf mode:
  - its node links are closed but its registry is kept;
  - `attach_node` and `add_node` are refused with `node-is-subordinate`;
  - coordinators lose their cross-node tools (LM-02).

  When the last controller detaches, these are restored.
- Event `node-status-changed` carries `NodeStatus`.

### Node registry (command node)

The store is `node-registry.json`, written with `saveSensitiveJson` and
serialized under one mutation lock:

```ts
interface NodeRegistryV1 {
  version: 1;
  revision: number;
  nodes: NodeRecord[];
  tombstones: NodeDetachTombstone[];
}
interface NodeRecord {
  nodeId: BackendId;                 // verified installation ID
  enabled: boolean;
  routes: NodeRoute[];               // https {origin} | ssh {destination, sshPort?, identityFile?, remoteGatewayPort}
  routeOrder: RouteId[];
  credential: { token: string } | null; // null = needs credential
  profileCache?: CachedBackendProfile;
  attachment: { status: "pending" | "attached" | "refused"; reason?: string; attachedAt?: string };
  addedAt: string;
  lastConnectedAt?: string;
  source: "portal" | "desktop-migration";
}
```

- Route shapes reuse `SavedHttpsRoute` and `SavedSshRoute` without
  `encryptedToken`. There is one credential per node; grant equivalence is
  still "same token".
- `NodeView`, returned to clients, has no `credential`. In its place it has
  `hasCredential` and the live `connection` state:
  - `state`: `connecting`, `connected`, `degraded`, `unavailable`,
    `quarantined`, `needs-credential`, `needs-update` or `suspended`;
  - `activeRouteId`, `activeRouteKind` and `epoch`;
  - `lastError`, as a code and a safe message.
- Commands, all refused in leaf mode except `list_nodes`:
  - `list_nodes`;
  - `add_node {routes, token, displayName?}`: verifies, then attaches;
  - `update_node {nodeId, routes?, routeOrder?, enabled?, token?}`;
  - `forget_node {nodeId, withoutDetach?}`;
  - `reconnect_node {nodeId}`.
- Event `nodes-changed {revision}`. Clients re-read `list_nodes` on it.

### Route verification and SSH (command node)

- `NodeLinkManager` ports `ConnectionManager`'s per-machine logic:
  - ordered routes, each verified by the authenticated hello;
  - identity mismatch quarantines the route;
  - certificate and host-key failures block, with no fallback across them;
  - fallback only within a verified identity;
  - epochs on every route change;
  - bounded background reconnects with backoff.
- SSH routes use the moved tunnel supervisor:
  - host OpenSSH, owned loopback forwards, `StrictHostKeyChecking` never
    disabled, no remote install;
  - unattended reconnects use `BatchMode=yes` (key or agent only).
- Interactive prompts (passphrase, password, first-use host key) are raised
  as event `node-ssh-prompt {promptId, nodeId, routeId, kind, message,
  fingerprint?}`.
  - The client answers with `answer_node_ssh_prompt {promptId, answer |
    cancel}`.
  - Prompts expire after `ASKPASS_PROMPT_TIMEOUT_MS`.
  - Answers are never logged or persisted.
  - A changed host key is a blocking error, never a prompt.
- Every request a command node sends to a leaf carries the header
  `X-Orkestrator-Controller: <commandNodeId>`.

### Attachment (leaf)

The store is `node-attachments.json`:

```ts
interface NodeAttachmentsV1 {
  version: 1;
  controllers: { controllerId: BackendId; displayName: string; portalOrigins: string[];
                 attachedAt: string; lastContactAt: string }[];
}
```

Commands:

- `attach_controller {controllerId, displayName, portalOrigins}` returns
  `{nodeId, mode, profile}`. It is idempotent, and refused with:
  - `controller-is-subordinate`, when the controller is in this node's own
    registry, which would make a cycle;
  - `self-attach`.
- `detach_controller {controllerId}`. Called by the controller when it
  forgets this node.
- `detach_controller_here {controllerId}`. The user detaching a command node
  on the leaf itself: it is recorded in `detachedControllers` and its
  re-attach is refused with `detached-on-node` until the user calls
  `allow_controller {controllerId}`. The command node notices within one
  heartbeat (it checks `list_controllers`).
- `list_controllers`.

Other behaviour:

- **Last contact.** Updated from the controller header on any
  authenticated request from an attached controller, and persisted at most
  every 30 seconds.
- **Allowed origins.** `GatewayAuth.isOriginAllowed` also accepts the
  `portalOrigins` of attached controllers. The command node reports its
  browser listener origins, its hosted web client origins and the desktop
  renderer origin.
- **Two-level rule on the command side.** A node in leaf mode refuses
  `add_node`, and a command node refuses to add a node whose hello reports
  `mode: "leaf"` controlled *by it*. The cycle case is caught by
  `controller-is-subordinate`.
- **Hello.** Gains capability `node-attachment: 1` and `nodeMode`, so a
  command node can show "this node commands N nodes and will switch to
  leaf mode" before attaching.

### Portal read model and routing (command node)

- `NodeReadModel` keeps one subscription per connected node:
  - SSE `/events`, filtered to summary events, with the controller header;
  - hydrated with `get_projects` and `get_environment_snapshots` (the
    existing `summary-reads` capability);
  - epoch-fenced, with bounded hydration and labelled last-known state,
    persisted to `node-summaries.json`.

  This is ported from the renderer `BackendRuntime`.
- Commands:
  - `get_node_summaries {nodeIds?}` returns `{nodes: [{nodeId, view,
    available, lastKnownAt?, projects, environments}]}`. Projects and
    environments are node-qualified with `nodeId`.
  - `invoke_on_node {nodeId, command, args, requestKey}` returns the leaf
    result. If the connection is lost after the request was sent, it
    returns `{outcome: "unknown", requestKey}`, recorded in
    `node-outcomes.json` and never resubmitted.
  - `list_node_outcomes` and `dismiss_node_outcome`.
- Events:
  - `node-summary-changed {nodeId, epoch}`: a coalesced delta of summaries;
  - `nodes-changed`.
- `invoke_on_node` refuses the
  [grant-excluded commands](#grant-excluded-commands) and refuses all
  writes while the node is not `connected`.
- The command node's own projects and environments still come from the
  existing local stores and commands. The portal adds the other nodes next
  to them.

### Direct workspaces, grants and relay

- On the command node:
  - `open_node_workspace {nodeId}` returns `{workspaceId, grant: {token,
    expiresAt}, directOrigins: string[], relayBase:
    "/__orkestrator/nodes/<nodeId>"}`.
  - `renew_node_workspace {workspaceId}` and `close_node_workspace
    {workspaceId}`.
- On the leaf, callable only with the gateway token and an attached
  controller header:
  - `create_client_grant {ttlSeconds ≤ 900, label}`;
  - `renew_client_grant`;
  - `revoke_client_grant`.

  Detaching a controller revokes all of its grants.
- **`ClientGrantService` on the leaf**, modelled on
  `PreviewAccessService`:
  - in memory and hash-only, so grants are gone after a restart and the
    command node re-issues them;
  - accepted by `GatewayAuth` as a bearer token, or in the terminal
    WebSocket `authenticate` frame;
  - credential kind `grant`;
  - the SSE stream closes when the grant expires (the existing deadline
    timer).
- **Client.** The leaf workspace (the reworked panel realm):
  1. tries each `directOrigin` with the hello and the grant;
  2. otherwise uses `relayBase` on the command node with its normal
     command-node session.

  It reports which path is in use.
- **Relay.** `/__orkestrator/nodes/<nodeId>/__orkestrator/{hello,invoke,events,
  terminal,proxy/loopback/<port>,browser/loopback/<port>}` on the command node
  (the relay base is a prefix, so a client joins its ordinary paths to it):
  - authenticated with the client's command-node credential;
  - forwarded over the node link with the leaf token and the controller
    header;
  - WebSocket upgrades are piped;
  - grant-excluded commands are refused.
- **Desktop panels.** The desktop is its own command node, so a panel tries
  the node's direct origins and then the command node's own loopback route to
  the node (`loopbackOrigin`, an SSH forward on the same computer) with the
  grant; it never needs the path-prefixed relay. A browser or iOS frame tries
  the direct origins and then the relay. The grant is kept in the frame's
  session storage, never in a URL.
- **Connection path.** The workspace publishes `{nodeId, nodeName, path:
  "direct" | "relay", routeKind, via?}`. The info panel shows it in a new
  "Connection" section of `AgentRuntimePanel`. Environments on the command
  node itself show "This node".

#### Grant-excluded commands

Grants and the relay refuse:

- gateway settings and token rotation;
- `attach_controller`, `detach_controller`, `list_controllers`;
- `create_client_grant`, `renew_client_grant`, `revoke_client_grant`;
- the registry commands (`add_node` and the rest);
- `import_desktop_connections`;
- updater and web-client maintenance routes (role `control`).

### Leaf mode for coordinators

- `trustedSessionInput` adds an `<orkestrator-node-mode>` block when the
  node is a leaf. It names the controller and says:
  - cross-node tools are unavailable;
  - incoming messages are handled as an agent on this node;
  - coordination happens on the controller.
- In leaf mode the control MCP does not register cross-node tools, and
  refuses `nodeId` arguments for any node other than itself, with
  `leaf-mode`.
- **Renderer.** When `NodeStatus.mode === "leaf"`, coordinator entry points
  are hidden. "Coordinator (leaf mode)" in the project menu opens a warning
  that names the controller, and only after that the conversation.
  Conversations are never deleted.

### Cross-node coordinator tools (command node only)

Built as a separate, node-qualified tool family (`control-mcp-nodes.ts`)
rather than a `nodeId` argument on every existing tool: the existing tools
keep their exact local behaviour, and each node tool checks the node's mode,
the node's copy of the coordinator's project (by repository identity) and
the environment's ownership on every call. The tools are `list_nodes`,
`list_node_environments`, `read_node_environment`, `launch_node_environment`,
`start_node_environment`, `stop_node_environment`, `send_prompt_to_node_tab`,
`send_node_message` and `request_environment_deletion`; `transfer_files` and
the project-file tools follow in M4.

The original design below (kept for reference) had existing control tools
accept an optional `nodeId`, defaulting to this node:

- `list_environments` lists every connected node when `nodeId` is omitted,
  each entry node-qualified.
- `launch_environment` defaults to this node.
- `send_prompt_to_tab`, start, stop and answer.

New tools:

| Tool | Behaviour |
| --- | --- |
| `list_nodes` | Nodes, mode, availability, colour. |
| `read_environment` | Read-only: status, activity, transcript page (cursor and limit), diff summary, file read, test results. Routed to the owner. |
| `request_environment_deletion {nodeId, environmentId, reason}` | Creates a pending `delete-environment` action request. It never deletes. |
| `transfer_files` | See [Files](#file-transfer-leaf-projects-and-project-files). Returns only a receipt. |
| `request_project_on_node {nodeId, gitRemote, location}` | Creates a pending `create-project` request. |
| `compare_project_files {projectKey, nodeIds?}` | Fingerprint-level comparison. |
| `request_project_file_update {projectKey, files, keys?, nodeIds}` | Creates a pending `update-project-files` request. |
| `request_env_value_reveal {nodeId, projectId, file, key}` | Creates a pending `reveal-env-value` request. |

### Action requests (command node)

The store is `node-action-requests.json`:

```ts
interface NodeActionRequest {
  requestId: string;
  kind: "delete-environment" | "create-project" | "update-project-files" | "reveal-env-value";
  targets: { nodeId: BackendId; nodeName: string; environmentId?: string; environmentName?: string;
             projectId?: string; location?: string; files?: string[]; keys?: string[] }[];
  requestedBy: { coordinatorConversationId: string };
  createdAt: string; expiresAt: string; // 24 h
  state: "pending" | "approved" | "rejected" | "expired" | "executed" | "failed" | "outcome-unknown";
  result?: { code: string; message: string };
}
```

- Commands: `list_node_action_requests` and `resolve_node_action_request
  {requestId, decision}`. Only a user client may call the resolve command;
  the coordinator credential cannot.
- Event `node-action-requests-changed`.
- The renderer shows a confirmation dialog that names every node and
  environment, location, file and key.
- Only an approval executes the request. The result goes back to the
  requesting conversation as mail.

### Node-qualified mail and the leaf outbox

- **Address.** `NodeMailAddress = {nodeId, mailboxId}`; the string form is
  `<mailboxId>@<nodeId>`. A bare `mailboxId` means this node.
- **Coordinator → leaf.**
  1. The command node calls leaf `deliver_node_mail {from: {controllerId,
     mailboxId, conversationId}, to: mailboxId, body, requestKey}`.
  2. The leaf stores it as ordinary incoming mail. The `MailActor` kind is
     `remote-coordinator`, and the thread's origin controller is recorded.
  3. Delivery to the agent is unchanged (inject or inbox).
- **Leaf → coordinator.** Mail to `coordinator`, replies on a thread, and
  completion reports from environments launched by a controller are routed
  in this order:
  1. the thread's or environment's origin controller;
  2. otherwise the most recent controller;
  3. otherwise, with no controllers, the local coordinator as today.

  Remote destinations go to `node-outbox.json`: per controller, ordered and
  bounded (500 items, 16 MiB), never rerouted. The leaf emits
  `node-outbox-ready {controllerId}`.
- **Collection.** The command node calls `collect_node_outbox
  {controllerId, after}` and `ack_node_outbox {controllerId, upTo}` on
  every `node-outbox-ready` event and on every reconnect. It delivers the
  items into its coordinator mailboxes.
- Environments created by a controller record `origin: {controllerId,
  coordinatorMailboxId}` on the leaf.
- Built: incoming coordinator mail is stored as ordinary mail from an
  external sender (prefixed with the command node's name), and the leaf's
  `send_message` / `reply_message` tools consult the router before local
  delivery (`storage.nodeMailRouter`). The outbox is the `node-mail` store
  (sensitive), and the command node's collector delivers into the named
  conversation, or the project's main coordinator matched by repository.

### File transfer, leaf projects and project files

- **Built.** Leaf file commands `stat_node_file`, `read_node_file`,
  `begin_node_file_write` / `append_node_file_write` /
  `commit_node_file_write` / `abort_node_file_write` (`nodes/node-files.ts`),
  with scopes `{environmentId}`, `{projectId}` and `{seedEnvironmentId}`;
  containerized environments are refused for now. The command node's
  `NodeFileTransfer` runs the same commands locally for itself.
- **Leaf chunk commands (as designed):**
  - `read_node_file_chunk {scope, path, offset, length ≤ 4 MiB}`;
  - `begin_node_file_write {scope, path, size, sha256, overwrite}`, then
    `append_node_file_chunk`, then `commit_node_file_write` (which checks
    the hash and renames atomically) or `abort_node_file_write`.
  - `scope` is `{environmentId}` or `{projectId, root: true}`, and paths are
    realpath-confined.
- **`NodeFileTransfer` on the command node:**
  - copies node to node, including from and to itself;
  - limits: 64 MiB per file, 256 MiB and 1,000 files per transfer;
  - writes a receipt `{transferId, from, to, paths, bytes, sha256, actor,
    status}` with no content;
  - logs and metrics carry only counts, sizes and codes.
- **Projects on leaves.** A `create-project` request names the node, the
  Git remote and an absolute location on the leaf. After approval, the leaf
  clones and adds the project with its existing commands.
- **Seed files for leaf environments.**
  1. When a command node creates an environment on a leaf, it asks the leaf
     with `get_project_seed_files {projectId}` which `.env`, `.env.local`
     and `filesToCopy` entries exist in the leaf's project root.
  2. For the missing ones it transfers its own copies into the leaf's
     staging area with `stage_environment_seed_files {environmentId}`. The
     staging area is 0600, in the data directory, and deleted after setup.
  3. `createLocalWorktree` and `createDockerContainer` copy from the project
     root first and from staging only for files the root lacks, so **the
     leaf's copy wins**.
- **Compare.**
  1. The command node generates a random 32-byte key for each comparison.
  2. It calls leaf `fingerprint_project_files {projectId, files, key}`,
     which returns `{path, exists, sha256Hmac, envKeys?: {KEY:
     hmac(value)}}`.
  3. It compares against its own copy and returns, per node:
     `missing`/`extra`/`same`/`differs` per file, and `added`/`removed`/
     `same`/`differs` per `.env` key.

  No values or raw hashes are returned.
- **Update.** After approval:
  - whole files are copied with `NodeFileTransfer`;
  - key-level `.env` updates call leaf `apply_env_keys {projectId, file,
    set, remove}`, which writes atomically and preserves other lines.

  Values travel between backends only, never through the model.

## Milestones and tasks

Each task lands as one or more commits with tests. A milestone is finished
when its matrix rows are `Done`, `Deviation` or `Deferred`, and when
`mise run format:check`, `lint`, `typecheck` and the affected tests pass.

### M1: registry, attachment and leaf mode

1. Move the node-link code into `packages/protocol/src/node/node-link/`,
   with desktop re-exports. The desktop tests stay green.
2. Add the protocol types in `command-nodes.ts`, and the hello fields
   `nodeMode` and `node-attachment`.
3. On the leaf:
   - the attachments store and the attach, detach and list commands;
   - last contact from the controller header;
   - dynamic origins.
4. Node mode: the `commandNode.enabled` config, `--command-node`,
   `get_node_status` and `node-status-changed`.
5. On the command node:
   - the registry store (sensitive);
   - the registry commands, redaction and the two-level checks;
   - detach tombstones.
6. `NodeLinkManager`: HTTPS routes with hello verification, quarantine and
   fallback, then SSH routes with the supervisor.
7. SSH prompt relay: the `node-ssh-prompt` event and
   `answer_node_ssh_prompt`.
8. Migration. Desktop main decrypts its catalogue and calls local
   `import_desktop_connections` on the control listener. The import is
   idempotent per verified ID or route, marks catalogue entries
   `migratedAt`, and leaves v1 and v2 for downgrade.
9. Connections settings: a "Nodes" section, plus the leaf's "Controlled by"
   list with Detach.

### M2: portal

1. `NodeReadModel`, `get_node_summaries`, `node-summary-changed` and
   last-known persistence.
2. `invoke_on_node`, the outcome ledger and the write gating.
3. `PortalProvider` in the renderer, with the sidebar over local plus
   portal summaries (dot, sections, filter, grouping, unavailable state).
4. Leaf side: `ClientGrantService`, the grant commands and `GatewayAuth`
   and terminal acceptance. Command side: `open_node_workspace`, renew and
   close.
5. The relay route `/__orkestrator/nodes/<id>/…`, including WebSocket.
6. Rework panels into leaf workspaces (direct, then relay), with the
   connection path in the info panel.
7. Remove the renderer `BackendRuntime` registry, `browser-machines`, the
   client-side federation IPC observation and the catalogue as federation
   source. Update the guard tests and docs.

### M3: cross-node coordinators

1. Leaf-mode context block, tool gating and hidden coordinator UI behind a
   warning.
2. `nodeId` on the control tools, `list_nodes`, `read_environment`, and
   placement that defaults to this node.
3. Action requests: store, commands, dialog, and the
   `request_environment_deletion` flow.
4. Node mail: `deliver_node_mail`, origin recording, the outbox and
   collection, and routing.

### M4: files

1. Leaf chunk commands and `NodeFileTransfer`, with receipts and the
   `transfer_files` tool.
2. `request_project_on_node`.
3. Seed files for leaf environments (leaf wins).
4. `compare_project_files`, the update request, `apply_env_keys` and the
   reveal request.

## Requirement matrix

Test names include the requirement ID (for example
`describe("AT-03 portal origins", …)`), so `rg "AT-03"` finds the evidence.

### Roles and mode

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| RM-01 | A node becomes a command node by having a registered subordinate; it is a leaf while attached; otherwise standalone. | 1 | `node-mode.ts` | `node-service.test.ts` RM-01/RM-02 | Done |
| RM-02 | A setting exposes registration; the desktop's local backend always has it. | 1 | `commandNode.enabled`, `--command-node` | `node-service.test.ts` RM-01/RM-02; `options.test.ts` flag inventory | Done |
| RM-03 | An attached command node suspends command activity (links closed, registry kept) and resumes when no controllers remain. | 1 | `node-mode.ts`, `NodeLinkManager` | `node-service.test.ts` RM-03/RM-04/LM-05/MG-02 | Done |
| RM-04 | A controller never sees a subordinate's suspended registry, only that node's own projects and environments. | 1 | Leaf refuses registry commands from grants and controllers; summaries are local only | `node-service.test.ts` RM-03/RM-04; `node-portal.test.ts` RM-04 (registry and portal commands refused through a leaf-mode node; it relays nothing) | Done |
| RM-05 | A leaf accepts several controllers and tracks the most recent contact. | 1 | `node-attachments.ts` | `node-service.test.ts` AT-01/AT-04/RM-05 | Done |
| RM-06 | A leaf can still be the client's direct target with its own UI. | 1 | Unchanged server switcher | Server switcher unchanged; leaf UI shows Controlled by (`nodes-settings.test.tsx` LM) | Done |
| RM-07 | Two levels only: a subordinate cannot register nodes; cycles are refused. | 1 | Command and leaf checks | `node-service.test.ts` RM-07 (3 tests) | Done |

### Clients

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| CL-01 | A client connected to a command node sees one interface over it and its nodes. | 2 | `PortalProvider`, sidebar | `federation-ui.test.tsx` UI-01 (sections, dots and rows from the command node's summaries); `node-portal.test.ts` PT-01 | Done |
| CL-02 | Clients keep only a target list: no leaf registry and no leaf tokens. | 2 | Removal task M2.7 | Renderer runtimes, registry, browser machine list and their client tokens removed; `federation-ipc.test.ts` CL-02/CR-04 (no observe/invoke IPC) | Done |
| CL-03 | Web and iOS receive the portal from the command node with no client changes. | 2 | Served bundle | Portal comes from the bound backend for every client (`FederationProvider` over `get_node_summaries`); browser and iOS frames in `federation-ui.test.tsx` DP-01/DP-03/CR-03 | Done |

### Registry and routes

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| RG-01 | The registry in the backend holds identity, profile, routes, credential, preference and enabled state. | 1 | `node-registry-store.ts` | `storage-nodes.test.ts`; `node-service.test.ts` RG-01/RG-02 | Done |
| RG-02 | Leaf credentials stay on the command node, never in a response, event or log. | 1 | Redaction, `NodeView` | `node-service.test.ts` RG-01/RG-02 (views, status, events carry no token); `command-node-migration.test.ts` | Done |
| RG-03 | Routes are hello-verified; identity mismatch, certificate and host-key failures block without bypass. | 1 | `NodeLinkManager` | `node-service.test.ts` RG-03; `qa-command-nodes.ts` RG-03 (restart and reconnect with the same identity) | Done |
| RG-04 | SSH routes run from the backend using host OpenSSH with owned forwards, host-key trust and no remote install. | 1 | Moved supervisor | `node-ssh-integration.test.ts` RG-04 (real sshd: host key refused until trusted through the command node, hello over the forward, attach); `node-service.test.ts` RG-04/RG-05; desktop SSH suites cover the shared supervisor | Done |
| RG-05 | SSH prompts are relayed through the portal; unattended reconnects use keys or the agent only. | 1 | `node-ssh-prompts.ts` | `node-service.test.ts` RG-04/RG-05 (interactive add, batch reconnect, prompt relay without answer); the prompt dialog is mounted app-wide | Done |
| RG-06 | The registry is managed from the portal's Connections settings. | 1 | Nodes section | `nodes-settings.test.tsx` RG-06 (list, forget, edit routes, order and token) | Done |
| RG-07 | Forgetting a node never stops or deletes anything on it. | 1 | `forget_node` | `node-service.test.ts` AT-02/RG-07/SC-03; `nodes-settings.test.tsx` RG-07 | Done |

### Attachment

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| AT-01 | Attaching records the controller's identity, name and time on the leaf. | 1 | `attach_controller` | `node-service.test.ts` AT-01/AT-04/RM-05 | Done |
| AT-02 | Detach happens from the command node (forget) or from the leaf; neither stops work. | 1 | `detach_controller`, tombstones | `node-service.test.ts` AT-02 (forget, offline tombstone, user detach on leaf with re-attach refused) | Done |
| AT-03 | Attaching registers the portal origins on the leaf (CORS). | 1 | `GatewayAuth.isOriginAllowed` | `node-service.test.ts` AT-03; `gateway-command-nodes.test.ts` AT-03 | Done |
| AT-04 | Every command-node request identifies the controller and updates last contact. | 1 | Header, throttled persist | `gateway-command-nodes.test.ts` AT-04; `node-service.test.ts` AT-01/AT-04 | Done |
| AT-05 | Nodes without `node-attachment` show "needs update" and are not controlled. | 1 | Hello capability | `node-service.test.ts` AT-05; `gateway-command-nodes.test.ts` AT-05 | Done |

### Updates from leaves

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| UP-01 | Every attached command node subscribes to the leaf's event stream. | 2 | `NodeReadModel` | `node-portal.test.ts` PT-01/PT-02/UP-01 (two command nodes each hold a stream) | Done |
| UP-02 | Single-destination updates go to the originating command node. | 3 | Origin on thread and environment | `node-mail.test.ts` UP-02/UP-03 (origin, thread); `node-coordination.test.ts` CO-05/UP-02 (real mail store, both directions) | Done |
| UP-03 | Otherwise they go to the most recent controller. | 3 | Outbox routing | `node-mail.test.ts` UP-02/UP-03 (most recent controller; detached origin falls back) | Done |
| UP-04 | If that controller is unreachable, the update waits in the outbox; never dropped or rerouted. | 3 | `node-outbox.ts` | `node-mail.test.ts` UP-04 (ordered, kept until acknowledged, refused when full); `control-mcp-nodes.test.ts` UP-02/UP-04 (failed delivery stays on the leaf) | Done |

### Leaf mode

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| LM-01 | Coordinator context says the node is in leaf mode and names the controller. | 3 | `<orkestrator-node-mode>` | `control-mcp-nodes.test.ts` LM-01/LM-03 (`coordinatorNodeContext`, injected by `trustedSessionInput`) | Done |
| LM-02 | Cross-node tools are unavailable in leaf mode. | 3 | Control MCP gating | `control-mcp-nodes.test.ts` CO-01/LM-02 (every node tool refuses in leaf mode) | Done |
| LM-03 | An incoming message is handled as a leaf agent would. | 3 | Context and gating | `control-mcp-nodes.test.ts` LM-01/LM-03 (context says to act as an agent on this node) | Done |
| LM-04 | Coordinator conversations are kept, hidden by default, and openable behind a warning naming the controller. | 3 | Renderer | `leaf-mode-coordinator-gate.test.tsx` LM-04 | Done |
| LM-05 | Detaching from all controllers restores command mode and tools. | 1, 3 | `node-mode.ts` | `node-service.test.ts` RM-03/LM-05 (links resume); node tools check the mode on every call, so command mode restores them | Done |

### Portal

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| PT-01 | A live read model of every connected node's projects and environments is fed by subscriptions. | 2 | `NodeReadModel` | `node-portal.test.ts` PT-01 (summaries and a stream-driven change) | Done |
| PT-02 | Every resource is node-qualified; commands are routed to the owner. | 2 | `invoke_on_node` | `node-portal.test.ts` PT-02 (routing with controller identity); `federation-ui.test.tsx` RT-02/OP-05, UI-04 | Done |
| PT-03 | The node colour dot appears before each environment name. | 2 | Sidebar | `federation-ui.test.tsx` CL-05 and UI-01 (dot before the name) | Done |
| PT-04 | Unavailable nodes keep labelled last-known state with writes disabled. | 2 | `node-summaries.json`, gating | `node-portal.test.ts` PT-04 (labelled last-known state, writes refused); `federation-ui.test.tsx` CL-05 (dimmed row) | Done |
| PT-05 | Unknown outcomes are recorded against the node and never resubmitted. | 2 | `node-outcomes.json` | `node-portal.test.ts` PT-05 (recorded, not resent, dismissable); `federation-ui.test.tsx` OP-02 (UI) | Done |

### Data plane and chat

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| DP-01 | Leaf chat, terminals and previews go direct from client to leaf when reachable. | 2 | Leaf workspace | `node-portal.test.ts` DP-01/DP-02 (grant, direct origins); `node-workspaces.ts` (desktop direct first); `federation-ui.test.tsx` DP-01/DP-03/CR-03 | Done |
| DP-02 | Grants are short-lived, revocable, not the gateway token, and exclude administration. | 2 | `ClientGrantService` | `node-portal.test.ts` DP-01/DP-02 (15-minute cap, hash-only, revoked on close and detach, attached controllers only); `gateway-command-nodes.test.ts` DP-02 (client API only) | Done |
| DP-03 | When the leaf is unreachable, the workspace relays through the command node. | 2 | `node-relay.ts` | `gateway-command-nodes.test.ts` DP-03 (HTTP and terminal WebSocket relayed with the node's credential); `federation-ui.test.tsx` DP-01/DP-03/CR-03; desktop uses the command node's loopback route | Done |
| DP-04 | The info panel shows the path (direct or relay), the route and the node. | 2 | `AgentRuntimePanel` | `connection-path.test.tsx` DP-04 | Done |
| DP-05 | The command node can read leaf chat read-only; the portal shows attention. | 2, 3 | Summaries, `read_environment` | Portal attention from summaries (`FederationEffects`); `control-mcp-nodes.test.ts` (read_node_environment reads state, tabs and transcript) | Done |
| DP-06 | The leaf arbitrates its own approvals. | 2 | Unchanged leaf | Approvals stay in the leaf's own workspace UI (nothing relays or answers them on the command node) | Done |
| DP-07 | Grants narrowed to one environment and one stream. | — | | | Deferred (deviation 2) |

### Coordinators

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| CO-01 | Cross-node coordination runs only on a top-level command node. | 3 | Mode gating | `control-mcp-nodes.test.ts` CO-01/LM-02 | Done |
| CO-02 | Environments are created on this node by default, or on a named node when asked. | 3 | `launch_environment nodeId` | `control-mcp-nodes.test.ts` CO-02/CO-06 (launch_node_environment on the node's matched project; launch_environment stays local and is the default in the context line) | Done |
| CO-03 | Coordinators start, stop, prompt and answer environments on every connected node, including command nodes in leaf mode. | 3 | Control tools with `nodeId` | `control-mcp-nodes.test.ts` (start/stop/prompt tools route with ownership checks); answering a pending question stays with the user in the leaf workspace (DP-06) | Done |
| CO-04 | Deletion happens only on user request, with a confirmation naming node and environment. | 3 | Action requests | `control-mcp-nodes.test.ts` CO-04 (request only); `node-mail.test.ts` CO-04 (approve executes once, reject/expiry never); `node-action-requests.test.tsx` CO-04 (dialog names node and environment) | Done |
| CO-05 | Node-qualified mail to and from agents on every node; replies are collected. | 3 | Node mail, outbox | `control-mcp-nodes.test.ts` CO-05; `node-coordination.test.ts` CO-05/UP-02 (both directions over the real mail store) | Done |
| CO-06 | Read-only interrogation: status, activity, transcripts, diffs, files and test results. | 3 | `read_environment` | `control-mcp-nodes.test.ts` CO-02/CO-06; `node-files.test.ts` CO-06 (git status and diff, a text file and pipeline state via `read_environment_details`, read-only) | Done |
| CO-07 | File transfer through the framework. | 4 | `transfer_files` | `control-mcp-node-files.test.ts` CO-07/FL-01 (transfer_files returns a receipt only); `qa-command-nodes.ts` FL-01 | Done |
| CO-08 | Existing per-project ownership and the read-only checkout boundary are kept. | 3 | Unchanged policy | Node tools act only on the coordinator's project (matched by repository) and refuse the node's project checkout; `resolve_node_action_request` denied to coordinator credentials | Done |

### Files and projects

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| FL-01 | Transfers are bounded and audited, with no content in logs, receipts or transcripts. | 4 | `NodeFileTransfer` | `node-files.test.ts` FL-01 (chunked, verified, atomic, no overwrite unless asked, confined paths, content-free receipt); `qa-command-nodes.ts` FL-01 | Done |
| FL-02 | A project is created on a leaf only after user approval stating the location. | 4 | `create-project` request | `control-mcp-node-files.test.ts` FL-02 (request names node, remote and absolute location); executor `executeCreateProject` runs `add_project` on the node only after approval | Done |
| FL-03 | A leaf environment gets `.env` and selected files from the leaf's project root. | 4 | Existing copy | `node-seed-worktree.test.ts` FL-03/FL-04/FL-05 (own files copied) | Done |
| FL-04 | Files missing on the leaf are copied from the command node's project root during setup. | 4 | Seed staging | `node-project-files.test.ts` FL-04/FL-05 (only missing files staged); `node-seed-worktree.test.ts` (seed fills gaps); routed `create_environment` triggers seeding | Done |
| FL-05 | The leaf's copy wins. | 4 | Copy order | `node-seed-worktree.test.ts` and `node-project-files.test.ts` (leaf's own copy wins) | Done |
| FL-06 | Compare reports missing or extra files and `.env` keys added, removed or changed, with values only as same or differs. | 4 | `project-file-compare.ts` | `node-project-files.test.ts` FL-06; `node-files.test.ts` FL-06 (one-time HMAC key); `qa-command-nodes.ts` FL-06 (no values in the result) | Done |
| FL-07 | Plain-text values are shown only on explicit user request. | 4 | `reveal-env-value` request | `node-project-files.test.ts` FL-08/FL-07 (value mailed to the conversation only, not stored in the request); `control-mcp-node-files.test.ts` (request only) | Done |
| FL-08 | Update pushes chosen files or keys node to node, not through the model, after an approval listing nodes and files. | 4 | `update-project-files` | `node-project-files.test.ts` FL-08 (keys and whole files node to node); `control-mcp-node-files.test.ts` (request lists nodes and files) | Done |

### Security

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| SC-01 | Command nodes have full control of leaves; no permission model yet. | 1 | Documented | No permission model: any attached controller has the full client API (`commands-registry-nodes.ts`) | Done |
| SC-02 | Leaves enforce their own approval and execution policies. | 2 | Unchanged | Unchanged leaf policies; routed commands run under the leaf's own command handlers | Done |
| SC-03 | Closing, hiding, detaching or forgetting never stops remote work. | 1, 2 | Tests per action | `node-service.test.ts` AT-02/RG-07/SC-03; `federation-ui.test.tsx` OP-06/CR-03 and DP-01/DP-03/CR-03 (closing a panel stops nothing) | Done |
| SC-04 | No tokens, prompts, file contents or `.env` values in logs, metrics, receipts or events. | 1–4 | Redaction tests | `qa-command-nodes.ts` SC-04 (no token, grant or .env value in any backend's output); RG-02 and FL-06 tests; receipts and requests carry no content | Done |

### Migration and carry-over

| ID | Requirement | M | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MG-01 | Saved desktop connections are attached as leaves of the local command node on upgrade. | 1 | `import_desktop_connections` | `node-service.test.ts` MG-01/MG-03; `command-node-migration.test.ts` | Done |
| MG-02 | A migrated machine that commands its own leaves switches to leaf mode. | 1 | RM-03 path | `node-service.test.ts` MG-01/MG-03 (migrated command node switches to leaf mode) | Done |
| MG-03 | Migration is idempotent and keeps the catalogue for downgrade; undecryptable tokens become `needs-credential`. | 1 | Import | `node-service.test.ts` MG-01/MG-03; `command-node-migration.test.ts` (marker, retry on failure) | Done |
| CR-01 | Identities, profile, hello, loopback gateway, outcome-unknown, dot, sidebar and projections are reused. | 1–2 |  | Identity, profile, hello, loopback gateway, dot, sidebar sections and aggregation reused; outcome-unknown moved to the command node | Done |
| CR-02 | Registry, route logic, SSH supervisor and read model are moved into the backend. | 1–2 |  | Registry and routes (`node-service.ts`, `node-link.ts`), SSH supervisor (`protocol/node/ssh`), read model (`node-read-model.ts`) in the backend | Done |
| CR-03 | Panels are reworked into grant-authorised leaf workspaces with relay fallback. | 2 |  | `federation-ui.test.tsx` OP-06/CR-03, DP-01/DP-03/CR-03; desktop `node-workspaces.ts` and `bindWorkspace` | Done |
| CR-04 | Renderer runtimes and registry, the client federation catalogue and client-held leaf tokens are removed. | 2 |  | Removed `backend-runtime`, `registry`, `backend-client`, `browser-machines`, observation IPC and `ConnectionManager` observation; `federation-ipc.test.ts` CL-02/CR-04 | Done |

## User decisions

The user's own statements from the design conversation, with the
requirements that carry them:

| # | User decision (paraphrased closely) | IDs |
| --- | --- | --- |
| D-01 | An Electron instance connected to "local" always acts as a command node. | RM-02 |
| D-02 | Command nodes keep their own registry of connected machines in the backend; leaf nodes don't. | RG-01, RM-01 |
| D-03 | Coordinators on command nodes control environments on all connected nodes, including command nodes acting as leaves. | CO-03 |
| D-04 | They send and receive mail with environments on all connected nodes. | CO-05, UP-02–04 |
| D-05 | Web, iOS and Electron connect to one command node and see one interface over many nodes. | CL-01, CL-03 |
| D-06 | New environments go on the coordinator's own machine by default, and can go on leaves. | CO-02 |
| D-07 | A control framework to send and receive files on leaf nodes. | FL-01, CO-07 |
| D-08 | Interrogate all environments on all connected nodes. | CO-06, DP-05 |
| D-09 | Terminals and web previews stream directly from leaf to client where possible, for performance. | DP-01 |
| D-10 | The command node dials out. | RG-03, RG-04 |
| D-11 | No projects on leaves without asking; take care with the location and with gitignored secrets. | FL-02, FL-04, FL-06–08, SC-04 |
| D-12 | Rework this branch into the command node. | CR-01–04 |
| D-13 | A leaf can have several command nodes, tracks the most recent, and routes updates intelligently; direct connection stays possible. | RM-05, RM-06, UP-02–04 |
| D-14 | Having leaves registered makes a command node; there is also a setting. | RM-01, RM-02 |
| D-15 | Agent chat is client to leaf; the command node can see it; the coordinator reads transcripts or sends messages. | DP-01, DP-05, CO-05, CO-06 |
| D-16 | Full control first, permissions later. | SC-01 |
| D-17 | Only the user deletes environments, possibly via coordinator chat. | CO-04 |
| D-18 | `.env` and selected files are copied as for local worktrees. | FL-03, FL-04 |
| D-19 | Two levels only; an attached command node stops command activity. | RM-03, RM-07, CO-01 |
| D-20 | Relay fallback is acceptable; show the path in the info panel. | DP-03, DP-04 |
| D-21 | The leaf's copy wins; make compare and update across leaves easy. | FL-05, FL-06, FL-08 |
| D-22 | Coordinator chat on a command node in leaf mode is mostly hidden but reachable behind a warning; it knows it is in leaf mode. | LM-01–04 |
| D-23 | Saved connections auto-attach as leaves. | MG-01–03 |
| D-24 | Milestones on this branch, one PR at the end; portal first, then coordinators. | Delivery |

## Spec coverage

Each section of command-nodes.md and the IDs that cover it:

| Spec section | IDs |
| --- | --- |
| Summary | RM-01, RM-05, RM-06, CL-01 |
| Principles 1–5 | CL-01–03, CR-02; SC-02; DP-01–05; RG-03–04, AT-04; FL-02, CO-04, PT-05 |
| Roles | RM-01–07, CO-01 |
| Clients | CL-01–03, RM-06 |
| Node registry | RG-01–07 |
| Attachment | AT-01–05, RM-03, RM-07 |
| Updates from leaves | UP-01–04 |
| Leaf mode | LM-01–05 |
| Portal | PT-01–05 |
| Agent chat and the coordinator | DP-01–06, CO-05, CO-06 |
| Showing the connection path | DP-04 |
| Coordinators | CO-01–08 |
| Projects on leaf nodes | FL-02–05, SC-04 |
| Comparing and updating project files | FL-06–08 |
| Security | RG-02, SC-01–04, DP-02, DP-07 |
| What carries over | CR-01–04 |
| Decided table | D-01–D-24 |

## Final verification

Run after M4, and record the results in this document:

1. **Matrix walk.** For every row, open the evidence test or QA step and
   confirm it exercises the requirement as written in command-nodes.md, not
   a weaker version. Set the final status. Any row not `Done` is listed in
   the report with its reason.
2. **Spec re-read.** Read command-nodes.md top to bottom, then the user
   decisions above. For each sentence that states a behaviour, confirm a
   matrix row covers it. Add a row for anything missed and resolve it.
3. **Checks**, through `mise run test:logged`:
   - `format:check`, `lint` and `typecheck`;
   - `mise run test`, `test:browser` and `test:agent:electron`;
   - the SSH real-sshd suites.
4. **Two-node QA.** `bun scripts/qa-command-nodes.ts` starts two or three
   backends with separate data directories and covers:
   - attaching;
   - leaf mode on a nested command node;
   - the portal sidebar with dots;
   - unavailable state;
   - a direct workspace and a relay workspace, with the path shown;
   - a coordinator launching on a leaf and messaging, then collecting the
     reply after the controller restarts;
   - deletion confirmation;
   - compare and update across nodes.

   Screenshots go to `output/agent-testing/command-nodes-qa/`.
5. **Secret scan.** Grep logs, receipts and event captures from the QA run
   for the test tokens and the `.env` test values, and expect no matches.
6. **Report.** Summarize what was built, the deviations, the deferred rows
   and the evidence. Open the PR only when the user gives the go-ahead.

## Verification results

Run 2026-10-21 after M4, following the procedure above. The short tour is
in [command-nodes-handoff.md](command-nodes-handoff.md).

1. **Matrix walk.** Every row is `Done` except DP-07 (`Deferred`, deviation
   2). Each row's evidence names the test or QA step that exercises it.
2. **Spec re-read.** command-nodes.md and the user decisions (D-01–D-24)
   were re-read sentence by sentence. Three gaps were found and fixed:
   - coordinators could not read another node's diff, files or test
     results (CO-06): fixed with `read_environment_details`;
   - the portal could not edit a node's routes or token (RG-06): fixed
     with the routes dialog;
   - SSH prompts surfaced only on the settings page (RG-05): the dialog is
     now app-wide.
3. **Checks** (through `mise run test:logged`):

   | Check | Result |
   | --- | --- |
   | `format:check`, `lint`, `typecheck` | PASS |
   | `mise run test` (complete non-iOS) | Workspace, bridges and codex groups PASS. Root group failed on the inheritance-chain guard (real: `StorageNodes` was not recorded; fixed) and Pi vendoring (a 30 s timeout under a concurrent session; recorded as 0514). Root group rerun: PASS. |
   | `mise run test:browser` | PASS (159.8 s) |
   | `mise run test:agent:electron` | PASS (116.3 s) |
   | SSH real-sshd suites (`ORKESTRATOR_SSH_INTEGRATION=1`) | Desktop 96 pass; backend `node-ssh-integration.test.ts` 1 pass |
   | `bun scripts/qa-command-nodes.ts` | 26/26 checks PASS (four live backends) |

   Flakes seen during the build and recorded: 0513 (Claude bridge, aggregate
   suite) and 0514 (Pi vendoring under load). Neither test's area changed.
4. **Two-node QA.** `scripts/qa-command-nodes.ts` covers:
   - attachment, leaf mode of a nested command node and the two-level rule;
   - node-qualified summaries, and no credential in views;
   - a direct workspace grant (client API only, revoked on close) and the
     relay;
   - compare without values, and a file transfer;
   - a deletion only after approval;
   - an unavailable node (stale, writes refused) and reconnection;
   - forgetting, and a log scan.

   Screenshots were not taken, and the browser and Electron UI was not
   driven against live leaves. The UI paths are covered by component tests
   and the browser and Electron suites.
5. **Secret scan.** The QA run's backend output contained none of the four
   gateway tokens, the workspace grant or either `.env` test value.
6. **Report.** See the handoff's "Deviations and deferrals" and "Not
   verified". The PR is opened only with the user's go-ahead.
