# Command nodes: implementation handoff

Handoff for [command-nodes.md](../architecture/command-nodes.md), built on
this branch in four milestones. The plan, contracts and the requirement
matrix with evidence for every row are in
[command-nodes-plan.md](command-nodes-plan.md). This page is the short tour.

## What a node does now

- **Every backend is a node.** Mode is derived, not configured:
  - `leaf` while any command node is attached;
  - `command` while it controls at least one attached node;
  - `standalone` otherwise.

  `get_node_status` reports the mode, and `node-status-changed` announces
  changes.
- **Registration.** A node may register others when
  `set_command_node_enabled` is on, or when it was launched with
  `--command-node`, which the desktop always passes for its local backend.
- **Leaf side** (`nodes/node-service.ts`):
  - `attach_controller` records the controller's identity, name, portal
    origins and time.
  - The controller header (`X-Orkestrator-Controller`) records the last
    contact.
  - Portal origins are allowed by CORS.
  - `detach_controller_here` is the user detaching a controller on the
    leaf, and `allow_controller` lets it attach again.
- **Command side** (`nodes/node-service.ts`, `nodes/node-link.ts`):
  - The registry lives in the sensitive store (`node-registry`). Its
    routes are HTTPS, or SSH through the shared OpenSSH supervisor in
    `packages/protocol/src/node/ssh`.
  - Every route is verified with the hello. An identity mismatch or a
    trust failure quarantines the node without trying another route, and
    a rejected token stops the link.
  - Heartbeats detect a restart or a detach on the leaf.
  - Forgetting a node keeps a detach tombstone until the leaf confirms.
- **Leaf mode.** Attaching a command node suspends its own links but keeps
  its registry. Registration is refused, and its coordinators lose their
  cross-node tools.
- **Inherited settings** (`nodes/node-controller-settings.ts`). The command
  node sends its inheritable settings with `sync_controller_settings` on
  every link connection and config change; the leaf keeps one copy per
  controller (`controller-settings.json`) and `ConfigRepository.loadConfig`
  lays the most recently changed one over the leaf's own config. Writers use
  `loadOwnConfig`. See [Settings](../architecture/command-nodes.md#settings).

## Portal

- **Read model** (`nodes/node-read-model.ts`):
  - It holds one event stream per connected node, opened with the
    command node's own credential.
  - Summaries are epoch-fenced and bounded, and the last-known state is
    persisted.
  - It is read with `get_node_summaries`, and `node-summary-changed`
    announces changes.
- **Routing.** `invoke_on_node` routes a command to its node:
  - writes are refused while the node is unavailable;
  - a lost answer becomes an outcome-unknown record (`list_node_outcomes`)
    and is never resent;
  - administrative commands never cross nodes (`NODE_EXCLUDED_COMMANDS`).
- **Leaf workspaces.** `open_node_workspace` returns a 15-minute,
  hash-only client grant issued by the leaf, along with the leaf's direct
  origins, a loopback origin and the relay base.
  - Grants work for the client API only.
  - They are renewed while the workspace is open, and revoked when it
    closes or the controller detaches.
- **Relay.** `/__orkestrator/nodes/<id>/__orkestrator/...` forwards HTTP and
  terminal WebSockets with the leaf's credential.
- **Renderer** (`lib/portal`, `components/federation`):
  - One `FederationProvider` reads the command node's portal over the
    portal channel (`lib/portal/portal-transport.ts`).
  - The window always stays on its command node. Opening another node's
    environment shows that node's workspace realm in the central region
    (`lib/federation/workspace-realm.ts`, `stores/remoteWorkspaceStore.ts`,
    `components/federation/RemoteWorkspaceRegion.tsx`), without reloading.
    The desktop binds a realm's child view to the node in main
    (`workspace-views.ts`, `setDesktopWorkspaceTarget`: direct first, then
    the command node's own route); a browser or iOS window keeps each
    realm's grant in session storage under its workspace ID
    (`workspaceTargetGatewayOptions` in the frame): direct first, then the
    relay.
  - The info panel shows the connection path.
- **Removed:**
  - renderer per-machine runtimes and the registry;
  - the browser machine list and its tokens;
  - desktop observation leases and the `backends` IPC.

## Coordinators

- **One tool family.** Every environment and workflow tool takes an
  optional `nodeId` (see
  [One tool family, every node](../architecture/command-nodes.md#one-tool-family-every-node));
  the original node tools below remain and share its paths.
- **Node tools** (`control-mcp-nodes.ts`, `control-mcp-node-files.ts`):
  - `list_nodes` and `list_node_environments`;
  - `read_node_environment`: state, tabs, transcript, diff, a file, and
    pipeline state;
  - `launch_node_environment`, `start_node_environment` /
    `stop_node_environment` and `send_prompt_to_node_tab`;
  - `send_node_message`;
  - `request_environment_deletion`;
  - `transfer_files` and `compare_project_files`;
  - `request_project_file_update`, `request_env_value_reveal` and
    `request_project_on_node`, which the user reviews in the project copy
    dialog.
- **Copying a project between machines** (`nodes/node-project-copy.ts`,
  `commands-registry-project-copy.ts`): clone plus the untracked and
  ignored files the user picks, in any direction.

  Every one of them refuses in leaf mode. Each node's copy of the project
  is matched by repository identity.
- **Context.** The coordinator's context names the node's role
  (`nodes/node-context.ts`).
- **Leaf mail** (`nodes/node-mail.ts`, `nodes/node-coordination.ts`):
  - Coordinator mail arrives on the leaf as trusted node mail that wakes
    the agent; a leaf agent's report wakes the coordinator, or is held
    while the coordinator waits on that worker.
  - An agent's mail to "coordinator", a reply on such a thread, or a
    report from a controller-launched environment goes to the originating
    command node, otherwise to the most recent one.
  - It waits in the leaf's outbox until that command node collects it.
- **Action requests** (`nodes/node-action-requests.ts`):
  - Deletions, file updates, value reveals and project creation run only
    after the user approves them in the request dialog, which names every
    node, environment, file and location.
  - Outcomes are mailed to the requesting conversation.

## Files

- **Transfers.** `nodes/node-files.ts` and `nodes/node-file-transfer.ts`
  copy files between environments and project roots on any node:
  - in 4 MiB chunks;
  - verified by size and SHA-256;
  - written atomically;
  - never overwriting unless asked;
  - leaving receipts that carry no content.
- **Seed files.** A `create_environment` routed to a leaf stages the
  `.env` and selected files that the leaf's project root lacks. Worktree
  and container setup use the leaf's own copy first.
- **Compare** uses one-time HMAC fingerprints, so no values leave a node.

## Migration and rollback

- **Import.** On the first start after upgrading, the desktop imports its
  saved machines into the local command node's registry
  (`import_desktop_connections`).
  - Verified machines keep their identity, and unverified ones adopt the
    identity their hello proves.
  - Machines whose token cannot be decrypted show "needs a token".
  - A marker file and the registry's import record make this run once.
- **Rollback.** The device catalogue is untouched, so a downgrade still has
  its saved machines.

## Deviations and deferrals

The details are in command-nodes-plan.md under "Deviations and
refinements".

1. **Leaf credentials** are kept in the backend's sensitive store (0600,
   secure-delete), not the OS keychain.
2. **Grants are workspace grants**: one leaf, one controller and one client
   session. Per-environment, per-stream grants (DP-07) are deferred.
3. **Node tools were a separate family** at first. With leaf parity every
   existing tool takes a `nodeId` instead; the separate tools remain for
   running conversations.
4. **"Answer" maps to prompting and messaging.** Answering a pending agent
   question on another node stays with the user in that leaf's workspace,
   as it does locally.
5. **No containerized file transfers.** File transfer into containerized
   environments is refused for now; seed files do reach containers.

## Not verified

- **A window moved to a leaf, live.** Switching is covered by unit, IPC
  and component tests, not yet run against two real backends.
- **Previews through the relay.** The relay forwards neither the preview
  tunnel nor relay-prefixed browser-loopback URLs, so a desktop connected
  to a *remote* command node that cannot reach a leaf directly has no
  previews of that leaf's environments. A desktop that is its own command
  node reaches leaves directly or over its own SSH route and is not
  affected.
- **iOS** was not built.
- **Windows SSH** is not qualified.
- **Leaf mail on the real stack.** `qa-command-nodes.ts` does not exercise
  it, because unstarted environments have no agent mailbox. It is covered
  by `node-coordination.test.ts` over the real mail store.
