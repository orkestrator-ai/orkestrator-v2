/**
 * `nodes` commands (plan item 7009): the node registry and its links, attached
 * command nodes (controllers), client grants, command handover, leaf
 * workspaces, the portal's summaries, layout, event relay and routing
 * (`invoke_on_node`), project file comparisons and copies, and the machine
 * profile. The mail and file parts of the node link are the pilot domains
 * `node-mail`, `node-files` and `ticket-sync` (plan item 1010).
 *
 * Every handler was strict (`assertOnlyKeys`); a defined command decodes
 * tolerantly, so unknown keys are now dropped, never refused (§11.4). Each
 * argument schema declares every key its handler reads, as
 * `optionalKey(Unknown)`: the handlers and services check each value with
 * their own messages (node identities, routes, import entries, bounded
 * strings), so nothing accepted today is refused and every error text is
 * unchanged. `invoke_on_node`'s `command` and `args` are the routed call's and
 * pass through untouched.
 *
 * `access`: every command a workspace grant or the relay refused before plan
 * item 7012 (the old deny-lists) is `admin` when it is the node's own user's
 * (registry, handover, portal, project copies) and `internal` when another
 * backend calls it over the link or a coordinator tool calls it in process
 * (controller attachment and settings, client grants, the leaf's file and
 * .env reads, unattended account switches); the five a workspace may reach
 * are `workspace`. `read` is `isNodeReadCommand(name)`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { openRecord } from "../../model-schema.js";
import { defineCommand } from "../../command.js";
import { nodesDomain } from "./domain.js";
import {
  AcceptCommandHandoverResultSchema,
  AccountSwitchOutcomeSchema,
  AgentsMdPreviewSchema,
  AppliedEnvKeysSchema,
  AttachControllerResultSchema,
  BackendProfileSchema,
  ClientGrantSchema,
  CommandHandoverPreviewSchema,
  CommandHandoverResultSchema,
  ControllerViewSchema,
  CreatedClientGrantSchema,
  EnvValuesSchema,
  EnvironmentDetailsSchema,
  HostKeyProbeSchema,
  ImportDesktopConnectionsResultSchema,
  NodeEventWatchResultSchema,
  NodeListResultSchema,
  NodeOutcomeRecordSchema,
  NodeSshPromptViewSchema,
  NodeStatusSchema,
  NodeSummariesResultSchema,
  NodeViewSchema,
  OpenedNodeWorkspaceSchema,
  PortalLayoutSchema,
  ProjectCopyOptionsSchema,
  ProjectCopyRecordSchema,
  ProjectFileComparisonSchema,
  ProjectFileFingerprintsSchema,
  RoutedResultSchema,
  SeedFilesSchema,
  SetupApprovalResultSchema,
  flagResult,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/** This node's mode, controllers and command-node setting. */
export const getNodeStatusCommand = defineCommand({
  domain: nodesDomain,
  name: "get_node_status",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: NodeStatusSchema,
  critical: [],
});

/** The portal sidebar's cross-machine order, shared by every client of this node. */
export const getPortalLayoutCommand = defineCommand({
  domain: nodesDomain,
  name: "get_portal_layout",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: PortalLayoutSchema,
  critical: [],
});

/** Reorders the portal sidebar; answers the stored layout. */
export const updatePortalLayoutCommand = defineCommand({
  domain: nodesDomain,
  name: "update_portal_layout",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    machineOrder: optionalUnknown,
    projectOrder: optionalUnknown,
    projectFolders: optionalUnknown,
    repositoryOrder: optionalUnknown,
  }),
  result: PortalLayoutSchema,
  critical: [],
});

/** Turns this node's command-node setting on or off. */
export const setCommandNodeEnabledCommand = defineCommand({
  domain: nodesDomain,
  name: "set_command_node_enabled",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    enabled: optionalUnknown,
  }),
  result: NodeStatusSchema,
  critical: [],
});

/** Leaf side: a command node attaching over its link. */
export const attachControllerCommand = defineCommand({
  domain: nodesDomain,
  name: "attach_controller",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    displayName: optionalUnknown,
    portalOrigins: optionalUnknown,
  }),
  result: AttachControllerResultSchema,
  critical: [],
});

/** Leaf side: a command node that forgets this node detaches itself. */
export const detachControllerCommand = defineCommand({
  domain: nodesDomain,
  name: "detach_controller",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
  }),
  result: flagResult("detached"),
  critical: [],
});

/** The user detaching a command node on this node; it may not re-attach until allowed. */
export const detachControllerHereCommand = defineCommand({
  domain: nodesDomain,
  name: "detach_controller_here",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
  }),
  result: flagResult("detached"),
  critical: [],
});

/** An attached command node handing down its settings. */
export const syncControllerSettingsCommand = defineCommand({
  domain: nodesDomain,
  name: "sync_controller_settings",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    settings: optionalUnknown,
  }),
  result: flagResult("applied"),
  critical: [],
});

/** Lets a command node the user detached here attach again. */
export const allowControllerCommand = defineCommand({
  domain: nodesDomain,
  name: "allow_controller",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
  }),
  result: flagResult("allowed"),
  critical: [],
});

/** The command nodes attached to this node. */
export const listControllersCommand = defineCommand({
  domain: nodesDomain,
  name: "list_controllers",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: Schema.Array(ControllerViewSchema),
  critical: [],
});

/** Command node: its registry of machines, never a credential. */
export const listNodesCommand = defineCommand({
  domain: nodesDomain,
  name: "list_nodes",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: NodeListResultSchema,
  critical: [],
});

/** Registers a machine; the token stays on this backend. */
export const addNodeCommand = defineCommand({
  domain: nodesDomain,
  name: "add_node",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    routes: optionalUnknown,
    routeOrder: optionalUnknown,
    token: optionalUnknown,
    displayName: optionalUnknown,
  }),
  result: NodeViewSchema,
  critical: [],
});

/** Changes a registered machine's routes, token or enabled flag. */
export const updateNodeCommand = defineCommand({
  domain: nodesDomain,
  name: "update_node",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    nodeId: optionalUnknown,
    routes: optionalUnknown,
    routeOrder: optionalUnknown,
    token: optionalUnknown,
    enabled: optionalUnknown,
  }),
  result: NodeViewSchema,
  critical: [],
});

/** Forgets a machine here; nothing on it is stopped or deleted. */
export const forgetNodeCommand = defineCommand({
  domain: nodesDomain,
  name: "forget_node",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    nodeId: optionalUnknown,
    withoutDetach: optionalUnknown,
  }),
  result: openRecord({ forgotten: Schema.Boolean, detached: Schema.Boolean }),
  critical: ["withoutDetach"],
});

/** Drops a pending detach of a forgotten machine. */
export const discardNodeDetachCommand = defineCommand({
  domain: nodesDomain,
  name: "discard_node_detach",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    nodeId: optionalUnknown,
  }),
  result: flagResult("discarded"),
  critical: [],
});

/** Restarts a machine's link now. */
export const reconnectNodeCommand = defineCommand({
  domain: nodesDomain,
  name: "reconnect_node",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    nodeId: optionalUnknown,
  }),
  result: NodeViewSchema,
  critical: [],
});

/** Open SSH prompts (passphrases, host keys) waiting for the user. */
export const listNodeSshPromptsCommand = defineCommand({
  domain: nodesDomain,
  name: "list_node_ssh_prompts",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: Schema.Array(NodeSshPromptViewSchema),
  critical: [],
});

/** Answers or cancels one SSH prompt. */
export const answerNodeSshPromptCommand = defineCommand({
  domain: nodesDomain,
  name: "answer_node_ssh_prompt",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    promptId: optionalUnknown,
    answer: optionalUnknown,
    cancel: optionalUnknown,
  }),
  result: flagResult("answered"),
  critical: [],
});

/** First-use host-key review for an SSH route, before any credential is offered. */
export const probeNodeHostKeyCommand = defineCommand({
  domain: nodesDomain,
  name: "probe_node_host_key",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    destination: optionalUnknown,
    sshPort: optionalUnknown,
  }),
  result: HostKeyProbeSchema,
  critical: [],
});

/** Trusts the host keys a probe found. */
export const trustNodeHostKeyCommand = defineCommand({
  domain: nodesDomain,
  name: "trust_node_host_key",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    probeId: optionalUnknown,
  }),
  result: openRecord({ added: Schema.Finite }),
  critical: [],
});

/** The portal's read model of every machine (command node). */
export const getNodeSummariesCommand = defineCommand({
  domain: nodesDomain,
  name: "get_node_summaries",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({
    nodeIds: optionalUnknown,
    includeSelf: optionalUnknown,
  }),
  result: NodeSummariesResultSchema,
  critical: [],
});

/** Routes one command to its node (command node); the routed command's arguments and answer pass through unchanged. */
export const invokeOnNodeCommand = defineCommand({
  domain: nodesDomain,
  name: "invoke_on_node",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    nodeId: optionalUnknown,
    command: optionalUnknown,
    args: optionalUnknown,
    requestKey: optionalUnknown,
  }),
  result: RoutedResultSchema,
  critical: ["requestKey"],
});

/** Leases a relay of one machine's events to this client (command node). */
export const watchNodeEventsCommand = defineCommand({
  domain: nodesDomain,
  name: "watch_node_events",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    nodeId: optionalUnknown,
    prefixes: optionalUnknown,
    watchId: optionalUnknown,
  }),
  result: NodeEventWatchResultSchema,
  critical: [],
});

/** Ends an event relay lease. */
export const unwatchNodeEventsCommand = defineCommand({
  domain: nodesDomain,
  name: "unwatch_node_events",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    watchId: optionalUnknown,
  }),
  result: flagResult("removed"),
  critical: [],
});

/** Routed writes whose answer was lost, per machine. */
export const listNodeOutcomesCommand = defineCommand({
  domain: nodesDomain,
  name: "list_node_outcomes",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    nodeId: optionalUnknown,
  }),
  result: Schema.Array(NodeOutcomeRecordSchema),
  critical: [],
});

/** Dismisses one outcome-unknown record. */
export const dismissNodeOutcomeCommand = defineCommand({
  domain: nodesDomain,
  name: "dismiss_node_outcome",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    outcomeId: optionalUnknown,
  }),
  result: flagResult("dismissed"),
  critical: [],
});

/** Opens a machine's workspace for a client with a short-lived grant. */
export const openNodeWorkspaceCommand = defineCommand({
  domain: nodesDomain,
  name: "open_node_workspace",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    nodeId: optionalUnknown,
  }),
  result: OpenedNodeWorkspaceSchema,
  critical: [],
});

/** Renews an opened workspace's grant. */
export const renewNodeWorkspaceCommand = defineCommand({
  domain: nodesDomain,
  name: "renew_node_workspace",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    workspaceId: optionalUnknown,
  }),
  result: openRecord({ expiresAt: Schema.Finite }),
  critical: [],
});

/** Closes an opened workspace and revokes its grant. */
export const closeNodeWorkspaceCommand = defineCommand({
  domain: nodesDomain,
  name: "close_node_workspace",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    workspaceId: optionalUnknown,
  }),
  result: flagResult("closed"),
  critical: [],
});

/** Leaf side: a client grant an attached command node requests for a workspace. */
export const createClientGrantCommand = defineCommand({
  domain: nodesDomain,
  name: "create_client_grant",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    ttlSeconds: optionalUnknown,
    label: optionalUnknown,
  }),
  result: CreatedClientGrantSchema,
  critical: [],
});

/** Leaf side: renews a client grant; `null` when it is gone. */
export const renewClientGrantCommand = defineCommand({
  domain: nodesDomain,
  name: "renew_client_grant",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    grantId: optionalUnknown,
    ttlSeconds: optionalUnknown,
  }),
  result: Schema.NullOr(ClientGrantSchema),
  critical: [],
});

/** Leaf side: revokes a client grant. */
export const revokeClientGrantCommand = defineCommand({
  domain: nodesDomain,
  name: "revoke_client_grant",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    grantId: optionalUnknown,
  }),
  result: flagResult("revoked"),
  critical: [],
});

/** A coordinator's account switch under the user's standing permission on this machine. */
export const runGrantedAgentAccountSwitchCommand = defineCommand({
  domain: nodesDomain,
  name: "run_granted_agent_account_switch",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    requestId: optionalUnknown,
    platform: optionalUnknown,
    nodeId: optionalUnknown,
    nodeName: optionalUnknown,
    accountId: optionalUnknown,
    accountLabel: optionalUnknown,
    previousAccountId: optionalUnknown,
    previousAccountLabel: optionalUnknown,
    requestedBy: optionalUnknown,
    reason: optionalUnknown,
  }),
  result: AccountSwitchOutcomeSchema,
  critical: [],
});

/** A coordinator's account switch under the permission of the self-timer that woke it. */
export const runTimerAgentAccountSwitchCommand = defineCommand({
  domain: nodesDomain,
  name: "run_timer_agent_account_switch",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    requestId: optionalUnknown,
    platform: optionalUnknown,
    nodeId: optionalUnknown,
    nodeName: optionalUnknown,
    accountId: optionalUnknown,
    accountLabel: optionalUnknown,
    previousAccountId: optionalUnknown,
    previousAccountLabel: optionalUnknown,
    requestedBy: optionalUnknown,
    reason: optionalUnknown,
    selfTimer: optionalUnknown,
  }),
  result: AccountSwitchOutcomeSchema,
  critical: [],
});

/** The section an AGENTS.md request's review diffs against (command node). */
export const previewAgentsMdUpdateCommand = defineCommand({
  domain: nodesDomain,
  name: "preview_agents_md_update",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    requestId: optionalUnknown,
  }),
  result: AgentsMdPreviewSchema,
  critical: [],
});

/** A worker environment's diff, one file or test results, on its own node. */
export const readEnvironmentDetailsCommand = defineCommand({
  domain: nodesDomain,
  name: "read_environment_details",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: optionalUnknown,
    include: optionalUnknown,
    path: optionalUnknown,
  }),
  result: EnvironmentDetailsSchema,
  critical: [],
});

/** Leaf side: which of a project's seed files exist here. */
export const getProjectSeedFilesCommand = defineCommand({
  domain: nodesDomain,
  name: "get_project_seed_files",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    projectId: optionalUnknown,
  }),
  result: SeedFilesSchema,
  critical: [],
});

/** Leaf side: keyed fingerprints of project files for a comparison (never contents). */
export const fingerprintProjectFilesCommand = defineCommand({
  domain: nodesDomain,
  name: "fingerprint_project_files",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: optionalUnknown,
    files: optionalUnknown,
    key: optionalUnknown,
  }),
  result: ProjectFileFingerprintsSchema,
  critical: [],
});

/** Leaf side: sets and removes keys in a project's .env file. */
export const applyEnvKeysCommand = defineCommand({
  domain: nodesDomain,
  name: "apply_env_keys",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: optionalUnknown,
    path: optionalUnknown,
    set: optionalUnknown,
    remove: optionalUnknown,
  }),
  result: AppliedEnvKeysSchema,
  critical: [],
});

/** Leaf side: reads named keys of a project's .env file, backend to backend. */
export const readEnvValuesCommand = defineCommand({
  domain: nodesDomain,
  name: "read_env_values",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    projectId: optionalUnknown,
    path: optionalUnknown,
    keys: optionalUnknown,
  }),
  result: EnvValuesSchema,
  critical: [],
});

/** Records an approved setup command list on every machine that has the project (the user's action). */
export const approveSetupCommandsOnNodesCommand = defineCommand({
  domain: nodesDomain,
  name: "approve_setup_commands_on_nodes",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    nodeId: optionalUnknown,
    projectId: optionalUnknown,
    hash: optionalUnknown,
  }),
  result: SetupApprovalResultSchema,
  critical: [],
});

/** Compares a project's seed files across machines (command node). */
export const compareProjectFilesCommand = defineCommand({
  domain: nodesDomain,
  name: "compare_project_files",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    projectId: optionalUnknown,
    nodeIds: optionalUnknown,
  }),
  result: ProjectFileComparisonSchema,
  critical: [],
});

/** What the copy dialog shows before a project copy. */
export const getProjectCopyOptionsCommand = defineCommand({
  domain: nodesDomain,
  name: "get_project_copy_options",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({
    nodeId: optionalUnknown,
    projectId: optionalUnknown,
  }),
  result: ProjectCopyOptionsSchema,
  critical: [],
});

/** Copies a project between two machines this command node controls. */
export const copyProjectToNodeCommand = defineCommand({
  domain: nodesDomain,
  name: "copy_project_to_node",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    requestKey: optionalUnknown,
    source: optionalUnknown,
    target: optionalUnknown,
    paths: optionalUnknown,
    rememberFiles: optionalUnknown,
  }),
  result: ProjectCopyRecordSchema,
  critical: [],
});

/** Project copies this command node recorded. */
export const listProjectCopiesCommand = defineCommand({
  domain: nodesDomain,
  name: "list_project_copies",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: Schema.Array(ProjectCopyRecordSchema),
  critical: [],
});

/** One-time import of the desktop's saved machines. */
export const importDesktopConnectionsCommand = defineCommand({
  domain: nodesDomain,
  name: "import_desktop_connections",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    entries: optionalUnknown,
  }),
  result: ImportDesktopConnectionsResultSchema,
  critical: [],
});

/** What making another node the command node would hand over. */
export const previewCommandHandoverCommand = defineCommand({
  domain: nodesDomain,
  name: "preview_command_handover",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    nodeId: optionalUnknown,
    targetNodeIds: optionalUnknown,
  }),
  result: CommandHandoverPreviewSchema,
  critical: [],
});

/** Makes a registered node the command node (the user's action only). */
export const handOverCommandCommand = defineCommand({
  domain: nodesDomain,
  name: "hand_over_command",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    nodeId: optionalUnknown,
    nodeIds: optionalUnknown,
    includeSelf: optionalUnknown,
    entries: optionalUnknown,
  }),
  result: CommandHandoverResultSchema,
  critical: ["nodeIds", "includeSelf", "entries"],
});

/** Leaf side: an attached command node making this node the command node. */
export const acceptCommandHandoverCommand = defineCommand({
  domain: nodesDomain,
  name: "accept_command_handover",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    entries: optionalUnknown,
    handoverId: optionalUnknown,
  }),
  result: AcceptCommandHandoverResultSchema,
  critical: ["handoverId"],
});

/** This machine's canonical profile (display name and colour token). */
export const getBackendProfileCommand = defineCommand({
  domain: nodesDomain,
  name: "get_backend_profile",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: BackendProfileSchema,
  critical: [],
});

/** Compare-and-swap edit of this machine's profile on `expectedRevision`. */
export const updateBackendProfileCommand = defineCommand({
  domain: nodesDomain,
  name: "update_backend_profile",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    expectedRevision: optionalUnknown,
    displayName: optionalUnknown,
    colorToken: optionalUnknown,
  }),
  result: BackendProfileSchema,
  critical: [],
});

/** Every defined `nodes` command. */
export const NODES_COMMANDS = [
  getNodeStatusCommand,
  getPortalLayoutCommand,
  updatePortalLayoutCommand,
  setCommandNodeEnabledCommand,
  attachControllerCommand,
  detachControllerCommand,
  detachControllerHereCommand,
  syncControllerSettingsCommand,
  allowControllerCommand,
  listControllersCommand,
  listNodesCommand,
  addNodeCommand,
  updateNodeCommand,
  forgetNodeCommand,
  discardNodeDetachCommand,
  reconnectNodeCommand,
  listNodeSshPromptsCommand,
  answerNodeSshPromptCommand,
  probeNodeHostKeyCommand,
  trustNodeHostKeyCommand,
  getNodeSummariesCommand,
  invokeOnNodeCommand,
  watchNodeEventsCommand,
  unwatchNodeEventsCommand,
  listNodeOutcomesCommand,
  dismissNodeOutcomeCommand,
  openNodeWorkspaceCommand,
  renewNodeWorkspaceCommand,
  closeNodeWorkspaceCommand,
  createClientGrantCommand,
  renewClientGrantCommand,
  revokeClientGrantCommand,
  runGrantedAgentAccountSwitchCommand,
  runTimerAgentAccountSwitchCommand,
  previewAgentsMdUpdateCommand,
  readEnvironmentDetailsCommand,
  getProjectSeedFilesCommand,
  fingerprintProjectFilesCommand,
  applyEnvKeysCommand,
  readEnvValuesCommand,
  approveSetupCommandsOnNodesCommand,
  compareProjectFilesCommand,
  getProjectCopyOptionsCommand,
  copyProjectToNodeCommand,
  listProjectCopiesCommand,
  importDesktopConnectionsCommand,
  previewCommandHandoverCommand,
  handOverCommandCommand,
  acceptCommandHandoverCommand,
  getBackendProfileCommand,
  updateBackendProfileCommand,
] as const;
