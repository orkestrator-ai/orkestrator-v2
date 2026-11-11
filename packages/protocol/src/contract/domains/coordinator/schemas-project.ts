/**
 * Result schemas of the `coordinator` commands' project part (plan item
 * 7009): the coordinator snapshot and its conditional view, project Git
 * state, workflow associations, and the answers of the coordinator's tool
 * commands (worker surfaces, delegations, goals, graph runs, reviews).
 *
 * Model records the protocol types (`CoordinatorSnapshot`,
 * `CoordinatorWorkflowAssociation`, `ProjectGitStatus`,
 * `MultiReviewActionResult`, ...) are `modelRecord<T>()`: the fields readers
 * route on are checked, every other key is kept, and the static type is the
 * protocol's own interface, so the web's casts go. Records only the backend
 * types (an environment, a tool command's JSON answer) are `openRecord`s with
 * the fields the handler writes, each optional unless the handler always
 * writes it, because tests fake the services with partial records and results
 * are validated there. Enumerations a newer backend may extend (lifecycle
 * states, workflow kinds, phases, statuses) are `Schema.String`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  CoordinatorConversation,
  CoordinatorSnapshot,
  CoordinatorWorkflowAssociation,
  CoordinatorWorkspace,
  ProjectGitStatus,
  ProjectGitSwitchConfirmation,
} from "../../../coordinator.js";
import type { BuildPipeline } from "../../../build-pipeline.js";
import type { MultiReviewActionResult, MultiReviewWorkflow } from "../../../multi-review.js";
import { modelRecord, OpenObject, openRecord } from "../../model-schema.js";

const optionalString = Schema.optional(Schema.String);
const optionalBoolean = Schema.optional(Schema.Boolean);
const optionalNumber = Schema.optional(Schema.Finite);
const NullableString = Schema.NullOr(Schema.String);

// --- The coordinator snapshot --------------------------------------------------

export const CoordinatorConversationSchema = modelRecord<CoordinatorConversation>()({
  id: Schema.String,
  tabId: optionalString,
  logicalSessionKey: optionalString,
  agent: optionalString,
  title: optionalString,
  closedAt: optionalString,
  startupError: optionalString,
  role: optionalString,
});

export const CoordinatorWorkspaceSchema = modelRecord<CoordinatorWorkspace>()({
  id: Schema.String,
  projectId: Schema.String,
  lifecycleState: optionalString,
  conversations: Schema.Array(CoordinatorConversationSchema),
  selectedConversationId: Schema.optional(NullableString),
  repositoryContextRevision: optionalNumber,
});

/** `CoordinatorWorkflowAssociation`: one workflow a coordinator follows. */
export const CoordinatorWorkflowAssociationSchema = modelRecord<CoordinatorWorkflowAssociation>()({
  id: Schema.String,
  coordinatorId: Schema.String,
  projectId: Schema.String,
  conversationId: optionalString,
  kind: Schema.String,
  resourceId: Schema.String,
  nodeId: optionalString,
  requestId: Schema.String,
  pending: optionalBoolean,
  createdAt: optionalString,
});

/** `CoordinatorSnapshot`: a project's coordinator workspace with its availability. */
export const CoordinatorSnapshotSchema = modelRecord<CoordinatorSnapshot>()({
  workspace: CoordinatorWorkspaceSchema,
  projectPath: optionalString,
  workflows: Schema.optional(Schema.Array(CoordinatorWorkflowAssociationSchema)),
  workflowStore: optionalString,
});

export const NullableCoordinatorSnapshotSchema = Schema.NullOr(CoordinatorSnapshotSchema);

const viewStamp = { generation: Schema.String, revision: Schema.Finite };

/**
 * `get_project_coordinator_view`: `ViewSnapshotOutcome<CoordinatorSnapshot>`
 * (`@orkestrator/protocol/view-sync`), `deleted` once the project has no
 * coordinator.
 */
export const CoordinatorViewOutcomeSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unchanged"), ...viewStamp }),
  Schema.Struct({
    status: Schema.Literal("snapshot"),
    ...viewStamp,
    snapshot: CoordinatorSnapshotSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("reset"),
    ...viewStamp,
    snapshot: CoordinatorSnapshotSchema,
    reason: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("deleted"), ...viewStamp }),
]);

/** `CoordinatorActivitySnapshot`: each busy project's activity (`working`, `waiting`). */
export const CoordinatorActivitySnapshotSchema = Schema.Struct({
  projects: Schema.Record(Schema.String, Schema.String),
});

/** `CoordinatorLaunchOverridesSnapshot`; `remoteOverrides` rows name their node. */
export const CoordinatorLaunchOverridesSnapshotSchema = Schema.Struct({
  overrides: Schema.Array(
    openRecord({
      environmentId: Schema.String,
      tabId: Schema.String,
      model: optionalString,
      reasoning: optionalString,
    }),
  ),
  remoteOverrides: Schema.optionalKey(
    Schema.Array(
      openRecord({
        nodeId: Schema.String,
        environmentId: Schema.String,
        tabId: Schema.String,
        model: optionalString,
        reasoning: optionalString,
      }),
    ),
  ),
});

/** `CoordinatorCheckoutTurn | null`: `kind` is `conversation` or `project-home`. */
export const CoordinatorCheckoutTurnSchema = Schema.NullOr(
  openRecord({ kind: Schema.String, conversationId: optionalString }),
);

/** `WatchPullRequestOutcome` (`coordinator-pr-watches.ts`). */
export const CoordinatorPullRequestWatchSchema = openRecord({
  watched: Schema.Boolean,
  added: optionalBoolean,
  reason: optionalString,
});

// --- Project Git -----------------------------------------------------------------

/** `ProjectGitStatus`: the project checkout's Git state. */
export const ProjectGitStatusSchema = modelRecord<ProjectGitStatus>()({
  projectId: Schema.String,
  repositoryRoot: optionalString,
  revision: Schema.Finite,
  branch: Schema.optional(NullableString),
  headCommit: Schema.optional(NullableString),
  remoteState: optionalString,
  operationState: optionalString,
  branches: Schema.optional(Schema.Array(OpenObject)),
  lastError: Schema.optional(Schema.NullOr(OpenObject)),
});

/** `ProjectGitSwitchConfirmation`: the one-time token to discard the shown state. */
export const ProjectGitSwitchConfirmationSchema = modelRecord<ProjectGitSwitchConfirmation>()({
  token: Schema.String,
  projectId: Schema.String,
  ref: Schema.String,
  expiresAt: Schema.String,
  trackedChanges: optionalNumber,
  untrackedFiles: optionalNumber,
  requiresEnhancedConfirmation: optionalBoolean,
});

/** `ProjectBaseBranchTip` (`project-git-service.ts`). */
export const ProjectBaseBranchTipSchema = openRecord({
  branch: Schema.String,
  commit: NullableString,
  ref: Schema.optional(NullableString),
  fetched: optionalBoolean,
  fetchError: optionalString,
  unavailableReason: optionalString,
});

/** `ProjectBaseContainment`: `{ contained: true }` or `{ contained: false, reason }`. */
export const ProjectBaseContainmentSchema = openRecord({
  contained: Schema.Boolean,
  reason: optionalString,
});

// --- Workflows and delegations --------------------------------------------------

/** `Environment` (backend models.ts): a worker environment record. */
export const CoordinatorEnvironmentSchema = openRecord({
  id: Schema.String,
  projectId: optionalString,
  name: optionalString,
  status: optionalString,
  environmentType: optionalString,
});

export const NullableCoordinatorEnvironmentSchema = Schema.NullOr(CoordinatorEnvironmentSchema);

/** `launch_coordinator_environment`: the worker, and whether its delegation opened. */
export const CoordinatorEnvironmentLaunchSchema = openRecord({
  environment: CoordinatorEnvironmentSchema,
  coordinatorDelegationOpened: Schema.Boolean,
  replayed: optionalBoolean,
  startError: optionalString,
});

export const CoordinatorDelegationAvailableSchema = Schema.Struct({ available: Schema.Boolean });
export const CoordinatorDelegationOpenedSchema = Schema.Struct({ opened: Schema.Boolean });

/** `BuildPipeline`, with `replayed` when a request id had already started it. */
export const CoordinatorBuildPipelineSchema = modelRecord<BuildPipeline>()({
  id: Schema.String,
  projectId: optionalString,
  environmentId: optionalString,
  phase: optionalString,
});

/** `MultiReviewWorkflow` snapshot. */
export const CoordinatorMultiReviewWorkflowSchema = modelRecord<MultiReviewWorkflow>()({
  id: Schema.String,
  projectId: optionalString,
  environmentId: optionalString,
  phase: optionalString,
});

/** `MultiReviewActionResult`: a review the coordinator launched or opened. */
export const MultiReviewActionResultSchema = modelRecord<MultiReviewActionResult>()({
  workflow: CoordinatorMultiReviewWorkflowSchema,
  outcome: Schema.String,
  reused: Schema.Boolean,
  ui: openRecord({
    status: Schema.String,
    tabId: optionalString,
    paneId: optionalString,
    layoutRevision: optionalNumber,
  }),
  recovery: optionalString,
  replayed: optionalBoolean,
});

// --- Tool command answers (JSON records the tools pass to the agent) -------------
//
// Most are receipt-backed (`withCoordinatorReceipt`): a retried request id
// answers the recorded result with `replayed: true`, typed as a plain record,
// so their fields are optional even where the first answer always has them.

/** Fields every receipt-backed answer may carry. */
const receipt = { replayed: optionalBoolean, nodeId: optionalString };

export const WorkerTerminalLaunchSchema = openRecord({
  environmentId: optionalString,
  tabId: optionalString,
  tabType: optionalString,
  status: optionalString,
  ...receipt,
});

export const WorkerBrowserOpenSchema = openRecord({
  environmentId: optionalString,
  url: optionalString,
  ui: Schema.optional(OpenObject),
  ...receipt,
});

export const WorkerTabEditSchema = openRecord({
  environmentId: optionalString,
  tabId: optionalString,
  operation: optionalString,
  toPaneId: optionalString,
  ...receipt,
});

/** The PR and Resolve tabs' launch answers (`launchWorkerPr`, `launchWorkerResolve`). */
export const WorkerPullRequestLaunchSchema = openRecord({
  status: optionalString,
  tabId: optionalString,
  prUrl: optionalString,
  ...receipt,
});

export const CoordinatorFeaturePlanLaunchSchema = openRecord({
  featureId: optionalString,
  phase: Schema.optional(NullableString),
  reused: optionalBoolean,
  ...receipt,
});

export const CoordinatorFeaturePlanSchema = openRecord({
  featureId: Schema.String,
  title: optionalString,
  status: optionalString,
  summary: optionalString,
  stories: Schema.optional(Schema.Array(openRecord({ id: Schema.String, title: optionalString }))),
  planning: Schema.optional(
    Schema.NullOr(openRecord({ phase: optionalString, failure: optionalString })),
  ),
  lastReply: Schema.optional(NullableString),
  buildPipelineId: optionalString,
});

/** A request the user approves on this machine (root changes, a worker's answer). */
export const CoordinatorApprovalRequestSchema = openRecord({
  environmentId: optionalString,
  tabId: optionalString,
  interactionId: optionalString,
  approvalRequestId: Schema.optional(Schema.Unknown),
  state: optionalString,
  ...receipt,
});

/** `RootChangesListing` (`root-changes.ts`). */
export const RootChangesListingSchema = openRecord({
  files: Schema.Array(OpenObject),
  truncated: Schema.Boolean,
  conflicts: Schema.Finite,
  headCommit: NullableString,
});

/** `ApplyRootChangesOutcome`: the files applied to the worker. */
export const ApplyRootChangesOutcomeSchema = openRecord({
  files: Schema.Array(Schema.String),
});

/** `stopWorkerTurn`'s answer, plus `delegationOpen` from the coordinator's command. */
export const WorkerTurnStopSchema = openRecord({
  environmentId: optionalString,
  tabId: optionalString,
  agent: optionalString,
  stopped: optionalBoolean,
  acknowledged: optionalBoolean,
  turn: optionalString,
  runId: optionalString,
  note: optionalString,
  delegationOpen: optionalBoolean,
  ...receipt,
});

/** `listWorkerCommands`: a tab's slash commands. */
export const WorkerCommandListSchema = openRecord({
  environmentId: optionalString,
  tabId: optionalString,
  agent: optionalString,
  catalogue: Schema.optional(Schema.Unknown),
  commands: Schema.optional(Schema.Array(OpenObject)),
  refresh: Schema.optional(Schema.Unknown),
  nodeId: optionalString,
});

/** `runWorkerCommand`, plus `delegationOpened` from the coordinator's command. */
export const WorkerCommandRunSchema = openRecord({
  command: optionalString,
  startsTurn: optionalBoolean,
  delegationOpened: optionalBoolean,
  ...receipt,
});

/** A build pipeline step restart (`restartHere`), with `followed` on the coordinator's. */
export const PipelineStepRestartSchema = openRecord({
  pipelineId: optionalString,
  restarted: optionalBoolean,
  alreadyRestarted: optionalBoolean,
  step: Schema.optional(Schema.Unknown),
  selection: Schema.optional(OpenObject),
  phase: optionalString,
  error: optionalString,
  followed: optionalBoolean,
  ...receipt,
});

/** A worker tab's goal answers (`set`/`get`/`pause`/`clear_coordinator_worker_goal`). */
export const WorkerGoalSchema = openRecord({
  environmentId: optionalString,
  tabId: optionalString,
  goal: Schema.optional(Schema.NullOr(OpenObject)),
  history: Schema.optional(Schema.Array(OpenObject)),
  wakeOwed: optionalBoolean,
  alreadyStopped: optionalBoolean,
  cleared: optionalBoolean,
  goalId: optionalString,
  replayed: optionalBoolean,
});

/** `SuborkAskResult` (`native-agent-suborks.ts`). */
export const SuborkAskResultSchema = openRecord({
  batchId: optionalString,
  suborks: Schema.optional(Schema.Array(OpenObject)),
  next: optionalString,
});

/** One template's launch view, or the project's template list. */
export const CoordinatorGraphTemplatesSchema = openRecord({
  template: Schema.optional(OpenObject),
  templates: Schema.optional(Schema.Array(OpenObject)),
  total: optionalNumber,
});

/** `start_coordinator_graph_run`: the launch (`GraphLaunchResult`) and its association. */
export const CoordinatorGraphLaunchSchema = openRecord({
  launch: OpenObject,
  associationId: Schema.String,
});

const GraphPosition = openRecord({
  activationKey: Schema.String,
  nodeId: Schema.String,
  error: optionalString,
});

/** `coordinatorGraphRunView`, with `cancelled` on a cancel. */
export const CoordinatorGraphRunViewSchema = openRecord({
  run: OpenObject,
  waitingFor: Schema.Array(GraphPosition),
  failed: Schema.Array(GraphPosition),
  terminal: Schema.Boolean,
  cancelled: optionalBoolean,
});

/** `WorkerAnswerOutcome`: `answered`, or `stale` with a reason. */
export const WorkerAnswerOutcomeSchema = openRecord({
  result: Schema.String,
  reason: optionalString,
});

/** A coordinator's mail: the sent message, or the held project-home request. */
export const CoordinatorMailResultSchema = openRecord({
  id: optionalString,
  placement: optionalString,
  coordinatorDelegationOpened: optionalBoolean,
  projectHome: optionalBoolean,
});

/** `send_approved_project_home_message`: `sent`, or `stale` with a reason. */
export const ApprovedProjectHomeMessageSchema = openRecord({
  result: Schema.String,
  reason: optionalString,
  messageId: optionalString,
  placement: optionalString,
});
