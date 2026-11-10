/**
 * `coordinator` commands, controller part (plan item 7009): the Control MCP
 * settings and credentials, native agent jobs (Control MCP and renderer),
 * a command node's coordinator acting on a node it controls
 * (`*_coordinator_node_*`, `fork_coordinator_worker`,
 * `get_coordinator_worker_changes`, run on the command node by its Control
 * MCP tools) and the controller-facing commands that run that work on the
 * node (`*_controller_*`, called over the node link). Registered by the
 * backend's `commands-registry-control.ts`,
 * `commands-registry-controller-workflows.ts`,
 * `commands-registry-coordinator-nodes.ts`, `coordinator-fork-worker.ts`
 * and `coordinator-worker-changes.ts`.
 *
 * Arguments: every key a handler reads is declared, because a defined
 * command drops the keys it does not declare. Every key is
 * `optionalKey(Unknown)`: each handler checks its arguments itself, in its
 * own order and with its own text (`asNonBlankString`, bounded strings,
 * nested `scope`/`input`/`launch` records, the `surface` text an older
 * command node matches), so nothing accepted today is refused and every
 * message is unchanged (§11.4). Nested records keep every key.
 *
 * `access`: the Control MCP settings and credentials are the node's own
 * secrets (`admin`); the controller-facing and coordinator-node commands are
 * workspace-excluded plumbing that only a command node's coordinator or this
 * node's Control MCP tools call (`internal`); the job launches, the
 * renderer's Multi Review button and its launch defaults are `workspace`.
 * `get_coordinator_node_launch_environment` is `internal` (plan item 7012): a
 * Control MCP tool step that trusts the scope its caller names, which no
 * client sends.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { coordinatorDomain } from "./domain.js";
import {
  AllowedSchema,
  AttachmentTransferResultSchema,
  AvailableSchema,
  ControlMcpSettingsSchema,
  ControllerEnvironmentSchema,
  ControllerForkResultSchema,
  ControllerWorkflowSnapshotSchema,
  CoordinatorForkResultSchema,
  CoordinatorNodeLaunchResultSchema,
  CoordinatorNodeMailResultSchema,
  CoordinatorNodeMailboxSchema,
  MultiReviewActionResultSchema,
  MultiReviewLaunchDefaultsSchema,
  NativeAgentJobLaunchResultSchema,
  OpenedSchema,
  WorkerActionResultSchema,
  WorkerChangesSchema,
  WorkerSurfaceResultSchema,
} from "./schemas-controller.js";

const arg = Schema.optionalKey(Schema.Unknown);

/** The Control MCP listener's settings and every operator credential (with tokens, for Copy setup). */
export const getControlMcpSettingsCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_control_mcp_settings",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: ControlMcpSettingsSchema,
  critical: [],
});

/** Replaces the `default` credential's token; answers the settings. */
export const rotateControlMcpTokenCommand = defineCommand({
  domain: coordinatorDomain,
  name: "rotate_control_mcp_token",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({}),
  result: ControlMcpSettingsSchema,
  critical: [],
});

/** Creates a named operator credential; answers the settings. */
export const createControlMcpCredentialCommand = defineCommand({
  domain: coordinatorDomain,
  name: "create_control_mcp_credential",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    label: arg,
    profile: arg,
    capabilities: arg,
    deniedActions: arg,
  }),
  result: ControlMcpSettingsSchema,
  critical: ["capabilities", "deniedActions"],
});

/** Replaces one credential's token; answers the settings. */
export const rotateControlMcpCredentialCommand = defineCommand({
  domain: coordinatorDomain,
  name: "rotate_control_mcp_credential",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    credentialId: arg,
  }),
  result: ControlMcpSettingsSchema,
  critical: [],
});

/** Revokes one credential; answers the settings. */
export const revokeControlMcpCredentialCommand = defineCommand({
  domain: coordinatorDomain,
  name: "revoke_control_mcp_credential",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    credentialId: arg,
  }),
  result: ControlMcpSettingsSchema,
  critical: [],
});

/** A Control MCP job: a native agent tab with its first prompt, validated against the model catalogue. */
export const launchControlJobCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_control_job",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: arg,
    requestId: arg,
    prompt: arg,
    title: arg,
    agent: arg,
    agentDefaulted: arg,
    conversationMode: arg,
    literal: arg,
    reviewTab: arg,
    attachments: arg,
    modelId: arg,
    reasoningId: arg,
    fastMode: arg,
    activateTab: arg,
    autoMergeEnabledAt: arg,
  }),
  result: NativeAgentJobLaunchResultSchema,
  critical: ["requestId", "attachments", "literal", "conversationMode"],
});

/** A renderer's native agent job (the same durable machinery), with completion actions and tab reuse. */
export const launchNativeAgentJobCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_native_agent_job",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: arg,
    requestId: arg,
    prompt: arg,
    title: arg,
    agent: arg,
    agentDefaulted: arg,
    conversationMode: arg,
    literal: arg,
    reviewTab: arg,
    attachments: arg,
    modelId: arg,
    reasoningId: arg,
    fastMode: arg,
    activateTab: arg,
    autoMergeEnabledAt: arg,
    autoMergePrUrl: arg,
    completionAction: arg,
    tabReuse: arg,
    tabId: arg,
  }),
  result: NativeAgentJobLaunchResultSchema,
  critical: [
    "requestId",
    "attachments",
    "literal",
    "conversationMode",
    "completionAction",
    "autoMergePrUrl",
    "tabReuse",
  ],
});

/** A command node's coordinator opens a terminal on a worker here, under the key it derived from its receipt. */
export const launchControllerTerminalCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_controller_terminal",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: arg,
    environmentId: arg,
    input: arg,
    key: arg,
  }),
  result: WorkerSurfaceResultSchema,
  critical: ["key"],
});

/** A command node's coordinator opens a worker's service in a browser tab here. */
export const openControllerBrowserCommand = defineCommand({
  domain: coordinatorDomain,
  name: "open_controller_browser",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: arg,
    environmentId: arg,
    url: arg,
    tabId: arg,
    title: arg,
    key: arg,
  }),
  result: WorkerSurfaceResultSchema,
  critical: ["key"],
});

/** A command node's coordinator focuses, moves or closes a worker tab here. */
export const editControllerWorkerTabCommand = defineCommand({
  domain: coordinatorDomain,
  name: "edit_controller_worker_tab",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: arg,
    environmentId: arg,
    tabId: arg,
    operation: arg,
    toPaneId: arg,
  }),
  result: WorkerSurfaceResultSchema,
  critical: [],
});

/** The Create PR action on a worker here, for a command node's coordinator. */
export const createControllerPrCommand = defineCommand({
  domain: coordinatorDomain,
  name: "create_controller_pr",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: arg,
    environmentId: arg,
    requestId: arg,
    targetBranch: arg,
  }),
  result: WorkerActionResultSchema,
  critical: ["requestId", "targetBranch"],
});

/** The Resolve Conflicts action on a worker here, for a command node's coordinator. */
export const resolveControllerConflictsCommand = defineCommand({
  domain: coordinatorDomain,
  name: "resolve_controller_conflicts",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: arg,
    environmentId: arg,
    requestId: arg,
    targetBranch: arg,
  }),
  result: WorkerActionResultSchema,
  critical: ["requestId", "targetBranch"],
});

/** A worker environment whose first prompt is shown as the command node's coordinator's delegation. */
export const createControllerEnvironmentCommand = defineCommand({
  domain: coordinatorDomain,
  name: "create_controller_environment",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    input: arg,
    controlRequestId: arg,
    presentation: arg,
  }),
  result: ControllerEnvironmentSchema,
  critical: ["controlRequestId", "presentation"],
});

/** A build pipeline here for a command node's coordinator, with this node's Build defaults. */
export const startControllerBuildPipelineCommand = defineCommand({
  domain: coordinatorDomain,
  name: "start_controller_build_pipeline",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    input: arg,
    coordinatorLaunchId: arg,
  }),
  result: ControllerWorkflowSnapshotSchema,
  critical: ["coordinatorLaunchId"],
});

/** The Multi Review button here, under the ID the command node reserved. */
export const launchControllerMultiReviewCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_controller_multi_review",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    input: arg,
    reservedId: arg,
  }),
  result: MultiReviewActionResultSchema,
  critical: ["reservedId"],
});

/** The Multi Review button for a renderer on this node, under the ID it minted per click. */
export const launchMultiReviewCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_multi_review",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    input: arg,
    reservedId: arg,
  }),
  result: MultiReviewActionResultSchema,
  critical: ["reservedId"],
});

/**
 * The rows a plain Multi Review click on an environment runs, resolved by the
 * environment's node from its saved settings and its own model catalogue: the
 * same rows `launch_multi_review` fills for omitted ones. Read-only.
 */
export const getMultiReviewLaunchDefaultsCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_multi_review_launch_defaults",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: arg,
  }),
  result: MultiReviewLaunchDefaultsSchema,
  critical: [],
});

/** Opens a saved review's root, Fix or reviewer tab, addresses its findings, or starts a custom fix. */
export const controllerMultiReviewSurfaceCommand = defineCommand({
  domain: coordinatorDomain,
  name: "controller_multi_review_surface",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    workflowId: arg,
    surface: arg,
    reviewerId: arg,
    instruction: arg,
    fixModel: arg,
  }),
  result: MultiReviewActionResultSchema,
  critical: ["fixModel"],
});

/** The low-level Multi Review start after a successful build, under a reserved ID. */
export const startControllerMultiReviewCommand = defineCommand({
  domain: coordinatorDomain,
  name: "start_controller_multi_review",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    input: arg,
    reservedId: arg,
    buildPipelineId: arg,
  }),
  result: ControllerWorkflowSnapshotSchema,
  critical: ["reservedId", "buildPipelineId"],
});

/** Forks a worker on the node owning it, for a command node's coordinator. */
export const forkControllerEnvironmentCommand = defineCommand({
  domain: coordinatorDomain,
  name: "fork_controller_environment",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: arg,
    environmentId: arg,
    environmentType: arg,
    controlRequestId: arg,
    launch: arg,
    delegation: arg,
  }),
  result: ControllerForkResultSchema,
  critical: ["controlRequestId", "delegation"],
});

/** A worker's changes on the node owning it, for a command node's coordinator. */
export const getControllerWorkerChangesCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_controller_worker_changes",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    projectId: arg,
    environmentId: arg,
    options: arg,
  }),
  result: WorkerChangesSchema,
  critical: [],
});

/** A coordinator's fork of one of its workers, here or on another node (Control MCP `fork_worker`). */
export const forkCoordinatorWorkerCommand = defineCommand({
  domain: coordinatorDomain,
  name: "fork_coordinator_worker",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    input: arg,
  }),
  result: CoordinatorForkResultSchema,
  critical: [],
});

/** A coordinator's read of a worker's changes, here or on another node (Control MCP `get_worker_changes`). */
export const getCoordinatorWorkerChangesCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_coordinator_worker_changes",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    scope: arg,
    input: arg,
  }),
  result: WorkerChangesSchema,
  critical: [],
});

/** The environment a coordinator's launch request made on a node, or null. */
export const getCoordinatorNodeLaunchEnvironmentCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_coordinator_node_launch_environment",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    scope: arg,
    requestId: arg,
    nodeId: arg,
  }),
  result: Schema.NullOr(ControllerEnvironmentSchema),
  critical: [],
});

/** A coordinator launches a worker environment on a node it controls. */
export const launchCoordinatorNodeEnvironmentCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_coordinator_node_environment",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    requestId: arg,
    nodeId: arg,
    input: arg,
    agentDefaulted: arg,
  }),
  result: CoordinatorNodeLaunchResultSchema,
  critical: ["requestId"],
});

/** Refuses unless a delegation to that worker tab on a node can be opened. */
export const assertCoordinatorNodeDelegationAvailableCommand = defineCommand({
  domain: coordinatorDomain,
  name: "assert_coordinator_node_delegation_available",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    nodeId: arg,
    environmentId: arg,
    tabId: arg,
    requestId: arg,
  }),
  result: AvailableSchema,
  critical: [],
});

/** Opens a coordinator's delegation to a worker tab on a node. */
export const openCoordinatorNodeDelegationCommand = defineCommand({
  domain: coordinatorDomain,
  name: "open_coordinator_node_delegation",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    nodeId: arg,
    environmentId: arg,
    tabId: arg,
    requestId: arg,
    request: arg,
  }),
  result: OpenedSchema,
  critical: ["requestId"],
});

/** The origin check of a coordinator tool naming an environment or workflow (`coordinator-environment-scope.ts`). */
export const assertCoordinatorEnvironmentScopeCommand = defineCommand({
  domain: coordinatorDomain,
  name: "assert_coordinator_environment_scope",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    target: arg,
  }),
  result: AllowedSchema,
  critical: [],
});

/**
 * A coordinator's call naming a node was refused because the node is not
 * connected. Nothing is queued: the backend remembers the attempt (in memory,
 * bounded) and wakes that conversation once when the node reconnects, so it
 * can retry from a fresh base (`coordinator-node-reconnect-wakes.ts`).
 */
export const noteCoordinatorNodeUnavailableCommand = defineCommand({
  domain: coordinatorDomain,
  name: "note_coordinator_node_unavailable",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    nodeId: arg,
  }),
  result: Schema.Struct({ noted: Schema.Boolean }),
  critical: [],
});

/** Mail from a coordinator to an agent, or the coordinator, on a node. */
export const sendCoordinatorNodeMailCommand = defineCommand({
  domain: coordinatorDomain,
  name: "send_coordinator_node_mail",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    nodeId: arg,
    toEnvironmentId: arg,
    toTabId: arg,
    requestId: arg,
    subject: arg,
    body: arg,
    attachments: arg,
    replyToMessageId: arg,
    deliverNow: arg,
  }),
  result: CoordinatorNodeMailResultSchema,
  critical: ["requestId", "attachments", "deliverNow", "replyToMessageId"],
});

/** `transfer_files` from a coordinator conversation's own attachments. */
export const transferCoordinatorAttachmentsCommand = defineCommand({
  domain: coordinatorDomain,
  name: "transfer_coordinator_attachments",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    to: arg,
    files: arg,
  }),
  result: AttachmentTransferResultSchema,
  critical: [],
});

/** Whether that node's copy of this project has a coordinator to mail. */
export const getCoordinatorNodeMailboxCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_coordinator_node_mailbox",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    scope: arg,
    nodeId: arg,
  }),
  result: CoordinatorNodeMailboxSchema,
  critical: [],
});

/** A coordinator starts a build pipeline on a node it controls. */
export const startCoordinatorNodeBuildPipelineCommand = defineCommand({
  domain: coordinatorDomain,
  name: "start_coordinator_node_build_pipeline",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    requestId: arg,
    nodeId: arg,
    input: arg,
  }),
  result: ControllerWorkflowSnapshotSchema,
  critical: ["requestId"],
});

/** A coordinator presses the Multi Review button on a node it controls. */
export const launchCoordinatorNodeMultiReviewCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_coordinator_node_multi_review",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    nodeId: arg,
    input: arg,
  }),
  result: MultiReviewActionResultSchema,
  critical: [],
});

/** A coordinator opens a review surface, or addresses its findings, on a node it controls. */
export const coordinatorNodeMultiReviewSurfaceCommand = defineCommand({
  domain: coordinatorDomain,
  name: "coordinator_node_multi_review_surface",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    nodeId: arg,
    workflowId: arg,
    surface: arg,
    reviewerId: arg,
    instruction: arg,
    requestId: arg,
    fixModel: arg,
  }),
  result: MultiReviewActionResultSchema,
  critical: ["requestId", "fixModel"],
});

/** A coordinator starts a Multi Review after a build on a node it controls. */
export const startCoordinatorNodeMultiReviewCommand = defineCommand({
  domain: coordinatorDomain,
  name: "start_coordinator_node_multi_review",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: arg,
    requestId: arg,
    nodeId: arg,
    buildPipelineId: arg,
    input: arg,
  }),
  result: ControllerWorkflowSnapshotSchema,
  critical: ["requestId", "buildPipelineId"],
});

/** The controller part of `COORDINATOR_COMMANDS`. */
export const COORDINATOR_CONTROLLER_COMMANDS = [
  getControlMcpSettingsCommand,
  rotateControlMcpTokenCommand,
  createControlMcpCredentialCommand,
  rotateControlMcpCredentialCommand,
  revokeControlMcpCredentialCommand,
  launchControlJobCommand,
  launchNativeAgentJobCommand,
  launchControllerTerminalCommand,
  openControllerBrowserCommand,
  editControllerWorkerTabCommand,
  createControllerPrCommand,
  resolveControllerConflictsCommand,
  createControllerEnvironmentCommand,
  startControllerBuildPipelineCommand,
  launchControllerMultiReviewCommand,
  launchMultiReviewCommand,
  getMultiReviewLaunchDefaultsCommand,
  controllerMultiReviewSurfaceCommand,
  startControllerMultiReviewCommand,
  forkControllerEnvironmentCommand,
  getControllerWorkerChangesCommand,
  forkCoordinatorWorkerCommand,
  getCoordinatorWorkerChangesCommand,
  getCoordinatorNodeLaunchEnvironmentCommand,
  launchCoordinatorNodeEnvironmentCommand,
  assertCoordinatorNodeDelegationAvailableCommand,
  openCoordinatorNodeDelegationCommand,
  assertCoordinatorEnvironmentScopeCommand,
  noteCoordinatorNodeUnavailableCommand,
  sendCoordinatorNodeMailCommand,
  transferCoordinatorAttachmentsCommand,
  getCoordinatorNodeMailboxCommand,
  startCoordinatorNodeBuildPipelineCommand,
  launchCoordinatorNodeMultiReviewCommand,
  coordinatorNodeMultiReviewSurfaceCommand,
  startCoordinatorNodeMultiReviewCommand,
] as const;
