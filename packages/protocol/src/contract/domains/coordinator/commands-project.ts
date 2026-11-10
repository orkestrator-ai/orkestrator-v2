/**
 * `coordinator` commands, project part (plan item 7009): the project's
 * coordinator workspace and conversations, its checkout's Git state, the
 * workflows it follows and delegates, and the backend commands behind the
 * coordinator's Control MCP tools (worker surfaces, turns, goals, suborks,
 * graph runs, reviews, questions and mail), with their `*_controller_*`
 * counterparts on the node that owns a worker. Registered from
 * `commands-registry-coordinator.ts` and the registrars it calls.
 *
 * Argument schemas declare every key the handler reads and decode tolerantly
 * (§11.4). A key the handler requires with `asNonBlankString` is
 * `Schema.String` (the same "Expected projectId to be a string" text; the
 * blank check stays in the handler). A key read leniently (`=== true`,
 * `typeof … === "string"`) or checked with the handler's own message (the
 * Control MCP tools' `scope` and `input` records, bounded lists, `null`-able
 * ids) is `optionalKey(Unknown)`, so nothing accepted today is refused and
 * every message is unchanged. Fields are listed in the order the handler
 * checks them, because a decode reports the first failure.
 *
 * `access`: the commands the old grant deny-lists refused (coordinator
 * tool plumbing, `*_controller_*` node-link commands, and the steps only the
 * user's approval runs) are `internal`, and so (plan item 7012) are the
 * Control MCP tool steps that trust the scope their caller names and that no
 * client sends: `launch_coordinator_environment`,
 * `open_coordinator_delegation`, `start_coordinator_build_pipeline`,
 * `start_coordinator_graph_run`, `start_coordinator_multi_review`,
 * `send_coordinator_agent_mail` and `ask_coordinator_suborks`. Every other
 * command is `workspace`.
 * `read` is `isNodeReadCommand(name)`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { coordinatorDomain } from "./domain.js";
import {
  ApplyRootChangesOutcomeSchema,
  ApprovedProjectHomeMessageSchema,
  CoordinatorActivitySnapshotSchema,
  CoordinatorApprovalRequestSchema,
  CoordinatorBuildPipelineSchema,
  CoordinatorCheckoutTurnSchema,
  CoordinatorDelegationAvailableSchema,
  CoordinatorDelegationOpenedSchema,
  CoordinatorEnvironmentLaunchSchema,
  CoordinatorFeaturePlanLaunchSchema,
  CoordinatorFeaturePlanSchema,
  CoordinatorGraphLaunchSchema,
  CoordinatorGraphRunViewSchema,
  CoordinatorGraphTemplatesSchema,
  CoordinatorLaunchOverridesSnapshotSchema,
  CoordinatorMailResultSchema,
  CoordinatorMultiReviewWorkflowSchema,
  CoordinatorPullRequestWatchSchema,
  CoordinatorSnapshotSchema,
  CoordinatorViewOutcomeSchema,
  CoordinatorWorkflowAssociationSchema,
  MultiReviewActionResultSchema,
  NullableCoordinatorEnvironmentSchema,
  NullableCoordinatorSnapshotSchema,
  PipelineStepRestartSchema,
  ProjectBaseBranchTipSchema,
  ProjectBaseContainmentSchema,
  ProjectGitStatusSchema,
  ProjectGitSwitchConfirmationSchema,
  RootChangesListingSchema,
  SuborkAskResultSchema,
  WorkerAnswerOutcomeSchema,
  WorkerBrowserOpenSchema,
  WorkerCommandListSchema,
  WorkerCommandRunSchema,
  WorkerGoalSchema,
  WorkerPullRequestLaunchSchema,
  WorkerTabEditSchema,
  WorkerTerminalLaunchSchema,
  WorkerTurnStopSchema,
} from "./schemas-project.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/**
 * Creates the project's coordinator workspace, or answers the one it has.
 * `keepConversationErrors` (`=== true`) keeps conversations' startup errors.
 */
export const ensureProjectCoordinatorCommand = defineCommand({
  domain: coordinatorDomain,
  name: "ensure_project_coordinator",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    keepConversationErrors: optionalUnknown,
  }),
  result: CoordinatorSnapshotSchema,
  critical: [],
});

/** Clears one conversation's startup failure so it can connect again. */
export const retryCoordinatorConversationCommand = defineCommand({
  domain: coordinatorDomain,
  name: "retry_coordinator_conversation",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    conversationId: Schema.String,
  }),
  result: CoordinatorSnapshotSchema,
  critical: [],
});

/** The project's coordinator snapshot, `null` before one exists. */
export const getProjectCoordinatorCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_project_coordinator",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
  }),
  result: NullableCoordinatorSnapshotSchema,
  critical: [],
});

/**
 * Watches a pull request a coordinator conversation rendered or opened. Was
 * strict (`assertOnlyKeys`); tolerant now. `owner`/`repo`/`number` and `source`
 * keep the handler's own messages.
 */
export const watchCoordinatorPullRequestCommand = defineCommand({
  domain: coordinatorDomain,
  name: "watch_coordinator_pull_request",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    owner: optionalUnknown,
    repo: optionalUnknown,
    number: optionalUnknown,
    source: optionalUnknown,
    projectId: Schema.String,
  }),
  result: CoordinatorPullRequestWatchSchema,
  critical: [],
});

/**
 * Conditional coordinator read. `knownGeneration`/`knownRevision` are checked
 * together by `parseViewSnapshotRequest`: a malformed pair answers a `reset`,
 * never an error.
 */
export const getProjectCoordinatorViewCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_project_coordinator_view",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
    knownGeneration: optionalUnknown,
    knownRevision: optionalUnknown,
  }),
  result: CoordinatorViewOutcomeSchema,
  critical: [],
});

/** Every project's coordinator activity, from retained observer answers only. */
export const listCoordinatorActivityCommand = defineCommand({
  domain: coordinatorDomain,
  name: "list_coordinator_activity",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: CoordinatorActivitySnapshotSchema,
  critical: [],
});

/** Worker tabs whose launch overrode the default, across every project. */
export const listCoordinatorLaunchOverridesCommand = defineCommand({
  domain: coordinatorDomain,
  name: "list_coordinator_launch_overrides",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: CoordinatorLaunchOverridesSnapshotSchema,
  critical: [],
});

/** Which turn holds the project's checkout, `null` when none. */
export const getCoordinatorCheckoutTurnCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_coordinator_checkout_turn",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
  }),
  result: CoordinatorCheckoutTurnSchema,
  critical: [],
});

/** Opens a side conversation. `title` and `closeUnused` are read leniently. */
export const createCoordinatorConversationCommand = defineCommand({
  domain: coordinatorDomain,
  name: "create_coordinator_conversation",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    title: optionalUnknown,
    closeUnused: optionalUnknown,
  }),
  result: CoordinatorSnapshotSchema,
  critical: [],
});

/** Assigns a conversation's provider, once. */
export const assignCoordinatorConversationAgentCommand = defineCommand({
  domain: coordinatorDomain,
  name: "assign_coordinator_conversation_agent",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    agent: Schema.String,
    projectId: Schema.String,
    conversationId: Schema.String,
  }),
  result: CoordinatorSnapshotSchema,
  critical: [],
});

/** Selects a conversation; `conversationId` may be `null` (checked by the handler). */
export const selectCoordinatorConversationCommand = defineCommand({
  domain: coordinatorDomain,
  name: "select_coordinator_conversation",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    conversationId: optionalUnknown,
  }),
  result: CoordinatorSnapshotSchema,
  critical: [],
});

/** Closes a conversation: stops its session, revokes its credentials. */
export const closeCoordinatorConversationCommand = defineCommand({
  domain: coordinatorDomain,
  name: "close_coordinator_conversation",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    conversationId: Schema.String,
  }),
  result: CoordinatorSnapshotSchema,
  critical: [],
});

/**
 * The Work panel's "Clear finished": hides rows, never removes records.
 * Retired: its last caller, the Work panel, left in v2.36.5-beta; counted
 * (`retired-command.hide-coordinator-work`) until its register row retires. Was
 * strict (`assertOnlyKeys`); tolerant now. `associationIds` keeps its own
 * bounded-list message.
 */
export const hideCoordinatorWorkCommand = defineCommand({
  domain: coordinatorDomain,
  name: "hide_coordinator_work",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    associationIds: optionalUnknown,
  }),
  result: NullableCoordinatorSnapshotSchema,
  critical: [],
});

/** Pauses the coordinator. */
export const pauseProjectCoordinatorCommand = defineCommand({
  domain: coordinatorDomain,
  name: "pause_project_coordinator",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
  }),
  result: CoordinatorSnapshotSchema,
  critical: [],
});

/** Resumes the coordinator. */
export const resumeProjectCoordinatorCommand = defineCommand({
  domain: coordinatorDomain,
  name: "resume_project_coordinator",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
  }),
  result: CoordinatorSnapshotSchema,
  critical: [],
});

/** The project checkout's Git status. */
export const getProjectGitStatusCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_project_git_status",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
  }),
  result: ProjectGitStatusSchema,
  critical: [],
});

/** Fetches the checkout's remote (`force === true` skips the freshness window). */
export const fetchProjectGitCommand = defineCommand({
  domain: coordinatorDomain,
  name: "fetch_project_git",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    force: optionalUnknown,
  }),
  result: ProjectGitStatusSchema,
  critical: [],
});

/** The tip a launch branches from: a named branch, else the project's default. */
export const getProjectBaseBranchTipCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_project_base_branch_tip",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
    branch: optionalUnknown,
  }),
  result: ProjectBaseBranchTipSchema,
  critical: [],
});

/** Whether `branch` contains `commit`. */
export const verifyProjectLaunchBaseCommand = defineCommand({
  domain: coordinatorDomain,
  name: "verify_project_launch_base",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    branch: Schema.String,
    commit: Schema.String,
  }),
  result: ProjectBaseContainmentSchema,
  critical: [],
});

/** Fast-forwards the checkout to its upstream. */
export const syncProjectGitCommand = defineCommand({
  domain: coordinatorDomain,
  name: "sync_project_git",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
  }),
  result: ProjectGitStatusSchema,
  critical: [],
});

/** Prepares a branch switch: the confirmation token for the state shown. */
export const prepareProjectGitBranchSwitchCommand = defineCommand({
  domain: coordinatorDomain,
  name: "prepare_project_git_branch_switch",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    ref: Schema.String,
  }),
  result: ProjectGitSwitchConfirmationSchema,
  critical: [],
});

/**
 * Switches the checkout's branch. Not critical: without `confirmationToken` a
 * receiver refuses to discard a dirty checkout, and without
 * `includeNestedRepositories` it leaves nested repositories alone, both the
 * safer reading.
 */
export const switchProjectGitBranchCommand = defineCommand({
  domain: coordinatorDomain,
  name: "switch_project_git_branch",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    ref: Schema.String,
    confirmationToken: optionalUnknown,
    includeNestedRepositories: optionalUnknown,
  }),
  result: ProjectGitStatusSchema,
  critical: [],
});

/** Stores an attachment in a coordinator conversation's directory; answers its path. */
export const writeCoordinatorAttachmentCommand = defineCommand({
  domain: coordinatorDomain,
  name: "write_coordinator_attachment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    filename: Schema.String,
    base64Data: Schema.String,
  }),
  result: Schema.String,
  critical: [],
});

/**
 * Records a workflow a coordinator follows. `kind` keeps its own message.
 * Retired: no release calls it (launches record their own associations);
 * counted (`retired-command.associate-coordinator-workflow`) until its
 * register row retires.
 */
export const associateCoordinatorWorkflowCommand = defineCommand({
  domain: coordinatorDomain,
  name: "associate_coordinator_workflow",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    coordinatorId: Schema.String,
    conversationId: optionalUnknown,
    kind: optionalUnknown,
    resourceId: Schema.String,
    requestId: Schema.String,
    baseBranch: optionalUnknown,
    baseCommit: optionalUnknown,
  }),
  result: CoordinatorWorkflowAssociationSchema,
  critical: [],
});

/** Moves a workflow to another conversation of the same coordinator. */
export const adoptCoordinatorWorkflowCommand = defineCommand({
  domain: coordinatorDomain,
  name: "adopt_coordinator_workflow",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    coordinatorId: Schema.String,
    conversationId: Schema.String,
    associationId: Schema.String,
  }),
  result: CoordinatorWorkflowAssociationSchema,
  critical: [],
});

/**
 * The coordinator's `launch_environment` tool: a worker environment with its
 * delegation. `scope` and `input` keep the handler's message; `requestId` is
 * read after them.
 */
export const launchCoordinatorEnvironmentCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_coordinator_environment",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    requestId: Schema.String,
    input: optionalUnknown,
    agentDefaulted: optionalUnknown,
  }),
  result: CoordinatorEnvironmentLaunchSchema,
  critical: ["requestId"],
});

/** The worker a coordinator's launch request created, `null` while none. */
export const getCoordinatorLaunchEnvironmentCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_coordinator_launch_environment",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    scope: optionalUnknown,
    requestId: optionalUnknown,
  }),
  result: NullableCoordinatorEnvironmentSchema,
  critical: [],
});

/**
 * Refuses a worker tab that already has another outstanding delegation. Keys
 * are read after the scope check, so they stay lenient here.
 */
export const assertCoordinatorDelegationAvailableCommand = defineCommand({
  domain: coordinatorDomain,
  name: "assert_coordinator_delegation_available",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    environmentId: Schema.String,
    tabId: Schema.String,
    requestId: Schema.String,
  }),
  result: CoordinatorDelegationAvailableSchema,
  critical: [],
});

/** Opens the delegation a worker tab owes this conversation one report for. */
export const openCoordinatorDelegationCommand = defineCommand({
  domain: coordinatorDomain,
  name: "open_coordinator_delegation",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    environmentId: Schema.String,
    tabId: Schema.String,
    requestId: Schema.String,
    request: optionalUnknown,
  }),
  result: CoordinatorDelegationOpenedSchema,
  critical: ["requestId"],
});

/** The coordinator's build pipeline launch (saved defaults fill omitted choices). */
export const startCoordinatorBuildPipelineCommand = defineCommand({
  domain: coordinatorDomain,
  name: "start_coordinator_build_pipeline",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    requestId: Schema.String,
    input: optionalUnknown,
  }),
  result: CoordinatorBuildPipelineSchema,
  critical: ["requestId"],
});

/**
 * A Multi Review after a coordinator's completed build pipeline. Retired: no
 * caller since Control MCP's `launch_multi_review` moved off it (v2.36.4-beta);
 * counted (`retired-command.start-coordinator-multi-review`) until its register
 * row retires.
 */
export const startCoordinatorMultiReviewCommand = defineCommand({
  domain: coordinatorDomain,
  name: "start_coordinator_multi_review",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    requestId: Schema.String,
    input: optionalUnknown,
    buildPipelineId: Schema.String,
  }),
  result: CoordinatorMultiReviewWorkflowSchema,
  critical: ["requestId"],
});

/** The Multi Review button for a coordinator (`isLaunchMultiReviewActionInput` checks `input`). */
export const launchCoordinatorMultiReviewActionCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_coordinator_multi_review_action",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: MultiReviewActionResultSchema,
  critical: [],
});

/** Opens a review's tab, or one reviewer's. */
export const openCoordinatorMultiReviewCommand = defineCommand({
  domain: coordinatorDomain,
  name: "open_coordinator_multi_review",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    workflowId: Schema.String,
    reviewerId: optionalUnknown,
  }),
  result: MultiReviewActionResultSchema,
  critical: [],
});

/** Opens a review's Address Findings tab. */
export const openCoordinatorMultiReviewFixCommand = defineCommand({
  domain: coordinatorDomain,
  name: "open_coordinator_multi_review_fix",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    workflowId: Schema.String,
  }),
  result: MultiReviewActionResultSchema,
  critical: [],
});

/** Starts Address Findings on a review. */
export const addressCoordinatorMultiReviewActionCommand = defineCommand({
  domain: coordinatorDomain,
  name: "address_coordinator_multi_review_action",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    workflowId: Schema.String,
  }),
  result: MultiReviewActionResultSchema,
  critical: [],
});

/** A custom Address Findings with the caller's instruction and model. */
export const customFixCoordinatorMultiReviewActionCommand = defineCommand({
  domain: coordinatorDomain,
  name: "custom_fix_coordinator_multi_review_action",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: MultiReviewActionResultSchema,
  critical: [],
});

/** Opens a terminal or tmux tab in a worker. */
export const launchCoordinatorTerminalCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_coordinator_terminal",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerTerminalLaunchSchema,
  critical: [],
});

/** Opens or navigates a worker's browser preview. */
export const openCoordinatorBrowserCommand = defineCommand({
  domain: coordinatorDomain,
  name: "open_coordinator_browser",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerBrowserOpenSchema,
  critical: [],
});

/** Renames, moves or closes a worker tab. */
export const editCoordinatorWorkerTabCommand = defineCommand({
  domain: coordinatorDomain,
  name: "edit_coordinator_worker_tab",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerTabEditSchema,
  critical: [],
});

/** The Create PR button for a worker. */
export const createCoordinatorPrCommand = defineCommand({
  domain: coordinatorDomain,
  name: "create_coordinator_pr",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerPullRequestLaunchSchema,
  critical: [],
});

/** The Resolve Conflicts button for a worker's pull request. */
export const resolveCoordinatorConflictsCommand = defineCommand({
  domain: coordinatorDomain,
  name: "resolve_coordinator_conflicts",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerPullRequestLaunchSchema,
  critical: [],
});

/** Starts one planning exchange. */
export const launchCoordinatorFeaturePlanCommand = defineCommand({
  domain: coordinatorDomain,
  name: "launch_coordinator_feature_plan",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: CoordinatorFeaturePlanLaunchSchema,
  critical: [],
});

/** A feature plan of the coordinator's project, bounded. */
export const getCoordinatorFeaturePlanCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_coordinator_feature_plan",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    scope: optionalUnknown,
    featureId: Schema.String,
  }),
  result: CoordinatorFeaturePlanSchema,
  critical: [],
});

/** Asks the user to copy the checkout's uncommitted changes into a worker. */
export const requestCoordinatorRootChangesCommand = defineCommand({
  domain: coordinatorDomain,
  name: "request_coordinator_root_changes",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: CoordinatorApprovalRequestSchema,
  critical: [],
});

/** The user's file picker: the checkout's changed files. */
export const listProjectRootChangesCommand = defineCommand({
  domain: coordinatorDomain,
  name: "list_project_root_changes",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
  }),
  result: RootChangesListingSchema,
  critical: [],
});

/** Runs only from an approved `apply-root-changes` request. */
export const applyProjectRootChangesCommand = defineCommand({
  domain: coordinatorDomain,
  name: "apply_project_root_changes",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    paths: optionalUnknown,
    projectId: Schema.String,
    environmentId: Schema.String,
  }),
  result: ApplyRootChangesOutcomeSchema,
  critical: [],
});

/** Stops the turn in one worker tab (also the Work panel's, with `stoppedBy: "user"`). */
export const stopCoordinatorWorkerTurnCommand = defineCommand({
  domain: coordinatorDomain,
  name: "stop_coordinator_worker_turn",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerTurnStopSchema,
  critical: [],
});

/** A worker tab's slash commands. */
export const listCoordinatorWorkerCommandsCommand = defineCommand({
  domain: coordinatorDomain,
  name: "list_coordinator_worker_commands",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerCommandListSchema,
  critical: [],
});

/** Runs one slash command in a worker tab. */
export const runCoordinatorWorkerCommandCommand = defineCommand({
  domain: coordinatorDomain,
  name: "run_coordinator_worker_command",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerCommandRunSchema,
  critical: [],
});

/** `stop_coordinator_worker_turn` on the node that owns the worker (node link only). */
export const stopControllerWorkerTurnCommand = defineCommand({
  domain: coordinatorDomain,
  name: "stop_controller_worker_turn",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    environmentId: optionalUnknown,
    tabId: Schema.String,
  }),
  result: WorkerTurnStopSchema,
  critical: [],
});

/** `list_coordinator_worker_commands` on the worker's node. */
export const listControllerWorkerCommandsCommand = defineCommand({
  domain: coordinatorDomain,
  name: "list_controller_worker_commands",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    projectId: Schema.String,
    environmentId: optionalUnknown,
    tabId: Schema.String,
    refresh: optionalUnknown,
  }),
  result: WorkerCommandListSchema,
  critical: [],
});

/** `run_coordinator_worker_command` on the worker's node. */
export const runControllerWorkerCommandCommand = defineCommand({
  domain: coordinatorDomain,
  name: "run_controller_worker_command",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    environmentId: optionalUnknown,
    tabId: Schema.String,
    command: Schema.String,
    arguments: optionalUnknown,
    expectedBindingRevision: optionalUnknown,
    key: Schema.String,
  }),
  result: WorkerCommandRunSchema,
  critical: ["key", "expectedBindingRevision"],
});

/** Restarts a step of a failed build pipeline. */
export const restartCoordinatorBuildPipelineStepCommand = defineCommand({
  domain: coordinatorDomain,
  name: "restart_coordinator_build_pipeline_step",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: PipelineStepRestartSchema,
  critical: [],
});

/** The same restart on the node that owns the pipeline (node link only). */
export const restartControllerBuildPipelineStepCommand = defineCommand({
  domain: coordinatorDomain,
  name: "restart_controller_build_pipeline_step",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    requestId: Schema.String,
    pipelineId: Schema.String,
    stepId: optionalUnknown,
    selection: optionalUnknown,
  }),
  result: PipelineStepRestartSchema,
  critical: ["requestId", "stepId", "selection"],
});

/** Sets a goal on a worker tab this coordinator launched or prompted. */
export const setCoordinatorWorkerGoalCommand = defineCommand({
  domain: coordinatorDomain,
  name: "set_coordinator_worker_goal",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerGoalSchema,
  critical: [],
});

/** A worker tab's goal and its history. */
export const getCoordinatorWorkerGoalCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_coordinator_worker_goal",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerGoalSchema,
  critical: [],
});

/** Pauses a worker tab's goal. */
export const pauseCoordinatorWorkerGoalCommand = defineCommand({
  domain: coordinatorDomain,
  name: "pause_coordinator_worker_goal",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerGoalSchema,
  critical: [],
});

/** Clears a worker tab's goal. */
export const clearCoordinatorWorkerGoalCommand = defineCommand({
  domain: coordinatorDomain,
  name: "clear_coordinator_worker_goal",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: WorkerGoalSchema,
  critical: [],
});

/** The coordinator's `ask_agents`: suborks in the project's own checkout. */
export const askCoordinatorSuborksCommand = defineCommand({
  domain: coordinatorDomain,
  name: "ask_coordinator_suborks",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: SuborkAskResultSchema,
  critical: [],
});

/** The project's graph templates, or one template's launch view. */
export const listCoordinatorGraphTemplatesCommand = defineCommand({
  domain: coordinatorDomain,
  name: "list_coordinator_graph_templates",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    scope: optionalUnknown,
    ref: optionalUnknown,
    environmentId: optionalUnknown,
  }),
  result: CoordinatorGraphTemplatesSchema,
  critical: [],
});

/** Launches a graph run for a coordinator. */
export const startCoordinatorGraphRunCommand = defineCommand({
  domain: coordinatorDomain,
  name: "start_coordinator_graph_run",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    requestId: optionalUnknown,
    request: optionalUnknown,
  }),
  result: CoordinatorGraphLaunchSchema,
  critical: ["requestId"],
});

/** A graph run of the coordinator's project. */
export const getCoordinatorGraphRunCommand = defineCommand({
  domain: coordinatorDomain,
  name: "get_coordinator_graph_run",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    scope: optionalUnknown,
    runId: optionalUnknown,
  }),
  result: CoordinatorGraphRunViewSchema,
  critical: [],
});

/** Cancels a graph run this coordinator may control. */
export const cancelCoordinatorGraphRunCommand = defineCommand({
  domain: coordinatorDomain,
  name: "cancel_coordinator_graph_run",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    runId: optionalUnknown,
  }),
  result: CoordinatorGraphRunViewSchema,
  critical: [],
});

/** Proposes an answer to a worker's question for the user to approve. */
export const requestCoordinatorWorkerAnswerCommand = defineCommand({
  domain: coordinatorDomain,
  name: "request_coordinator_worker_answer",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    input: optionalUnknown,
  }),
  result: CoordinatorApprovalRequestSchema,
  critical: [],
});

/** Runs only from an approved `answer-worker-question` request for a worker here. */
export const answerProjectWorkerQuestionCommand = defineCommand({
  domain: coordinatorDomain,
  name: "answer_project_worker_question",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    environmentId: Schema.String,
    tabId: optionalUnknown,
    interactionId: optionalUnknown,
    revision: optionalUnknown,
    answers: optionalUnknown,
  }),
  result: WorkerAnswerOutcomeSchema,
  critical: ["revision"],
});

/** The same, for a command node's approved request (node link only). */
export const answerControllerWorkerQuestionCommand = defineCommand({
  domain: coordinatorDomain,
  name: "answer_controller_worker_question",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    environmentId: Schema.String,
    tabId: optionalUnknown,
    interactionId: optionalUnknown,
    revision: optionalUnknown,
    answers: optionalUnknown,
  }),
  result: WorkerAnswerOutcomeSchema,
  critical: ["revision"],
});

/** The coordinator's `send_message`: to a worker, the other conversation or the project home. */
export const sendCoordinatorAgentMailCommand = defineCommand({
  domain: coordinatorDomain,
  name: "send_coordinator_agent_mail",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    projectId: Schema.String,
    coordinatorId: Schema.String,
    conversationId: Schema.String,
    requestId: Schema.String,
    toEnvironmentId: Schema.String,
    toTabId: optionalUnknown,
    subject: optionalUnknown,
    body: Schema.String,
    replyToMessageId: optionalUnknown,
    deliverNow: optionalUnknown,
    projectHomeReason: optionalUnknown,
    attachments: optionalUnknown,
    /** A scheduled fire's recorded turn origin; see `coordinatorCallTurnOrigin`. */
    turnOrigin: optionalUnknown,
  }),
  result: CoordinatorMailResultSchema,
  critical: ["requestId", "deliverNow", "attachments"],
});

/** Runs only from the user's approval of a `message-project-home` request. */
export const sendApprovedProjectHomeMessageCommand = defineCommand({
  domain: coordinatorDomain,
  name: "send_approved_project_home_message",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    approvalRequestId: Schema.String,
  }),
  result: ApprovedProjectHomeMessageSchema,
  critical: [],
});

/** The project part of `COORDINATOR_COMMANDS`. */
export const COORDINATOR_PROJECT_COMMANDS = [
  ensureProjectCoordinatorCommand,
  retryCoordinatorConversationCommand,
  getProjectCoordinatorCommand,
  watchCoordinatorPullRequestCommand,
  getProjectCoordinatorViewCommand,
  listCoordinatorActivityCommand,
  listCoordinatorLaunchOverridesCommand,
  getCoordinatorCheckoutTurnCommand,
  createCoordinatorConversationCommand,
  assignCoordinatorConversationAgentCommand,
  selectCoordinatorConversationCommand,
  closeCoordinatorConversationCommand,
  hideCoordinatorWorkCommand,
  pauseProjectCoordinatorCommand,
  resumeProjectCoordinatorCommand,
  getProjectGitStatusCommand,
  fetchProjectGitCommand,
  getProjectBaseBranchTipCommand,
  verifyProjectLaunchBaseCommand,
  syncProjectGitCommand,
  prepareProjectGitBranchSwitchCommand,
  switchProjectGitBranchCommand,
  writeCoordinatorAttachmentCommand,
  associateCoordinatorWorkflowCommand,
  adoptCoordinatorWorkflowCommand,
  launchCoordinatorEnvironmentCommand,
  getCoordinatorLaunchEnvironmentCommand,
  assertCoordinatorDelegationAvailableCommand,
  openCoordinatorDelegationCommand,
  startCoordinatorBuildPipelineCommand,
  startCoordinatorMultiReviewCommand,
  launchCoordinatorMultiReviewActionCommand,
  openCoordinatorMultiReviewCommand,
  openCoordinatorMultiReviewFixCommand,
  addressCoordinatorMultiReviewActionCommand,
  customFixCoordinatorMultiReviewActionCommand,
  launchCoordinatorTerminalCommand,
  openCoordinatorBrowserCommand,
  editCoordinatorWorkerTabCommand,
  createCoordinatorPrCommand,
  resolveCoordinatorConflictsCommand,
  launchCoordinatorFeaturePlanCommand,
  getCoordinatorFeaturePlanCommand,
  requestCoordinatorRootChangesCommand,
  listProjectRootChangesCommand,
  applyProjectRootChangesCommand,
  stopCoordinatorWorkerTurnCommand,
  listCoordinatorWorkerCommandsCommand,
  runCoordinatorWorkerCommandCommand,
  stopControllerWorkerTurnCommand,
  listControllerWorkerCommandsCommand,
  runControllerWorkerCommandCommand,
  restartCoordinatorBuildPipelineStepCommand,
  restartControllerBuildPipelineStepCommand,
  setCoordinatorWorkerGoalCommand,
  getCoordinatorWorkerGoalCommand,
  pauseCoordinatorWorkerGoalCommand,
  clearCoordinatorWorkerGoalCommand,
  askCoordinatorSuborksCommand,
  listCoordinatorGraphTemplatesCommand,
  startCoordinatorGraphRunCommand,
  getCoordinatorGraphRunCommand,
  cancelCoordinatorGraphRunCommand,
  requestCoordinatorWorkerAnswerCommand,
  answerProjectWorkerQuestionCommand,
  answerControllerWorkerQuestionCommand,
  sendCoordinatorAgentMailCommand,
  sendApprovedProjectHomeMessageCommand,
] as const;
