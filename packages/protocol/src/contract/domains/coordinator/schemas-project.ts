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
 * types (an environment, a tool command's JSON answer) are `openStruct`s with
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
import { modelRecord } from "../../model-schema.js";

/**
 * A struct whose listed fields are checked and typed while every other key
 * passes a decode (`Schema.StructWithRest`), typed as the plain struct.
 */
export function openStruct<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
): Schema.Codec<Schema.Struct<Fields>["Type"], Schema.Struct<Fields>["Encoded"]> {
  return Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]) as unknown as Schema.Codec<Schema.Struct<Fields>["Type"], Schema.Struct<Fields>["Encoded"]>;
}

/** Any JSON object, every key kept. */
export const CoordinatorOpenObject = openStruct({});

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

/** `CoordinatorLaunchOverridesSnapshot`. */
export const CoordinatorLaunchOverridesSnapshotSchema = Schema.Struct({
  overrides: Schema.Array(
    openStruct({
      environmentId: Schema.String,
      tabId: Schema.String,
      model: optionalString,
      reasoning: optionalString,
    }),
  ),
});

/** `CoordinatorCheckoutTurn | null`: `kind` is `conversation` or `project-home`. */
export const CoordinatorCheckoutTurnSchema = Schema.NullOr(
  openStruct({ kind: Schema.String, conversationId: optionalString }),
);

/** `WatchPullRequestOutcome` (`coordinator-pr-watches.ts`). */
export const CoordinatorPullRequestWatchSchema = openStruct({
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
  branches: Schema.optional(Schema.Array(CoordinatorOpenObject)),
  lastError: Schema.optional(Schema.NullOr(CoordinatorOpenObject)),
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
export const ProjectBaseBranchTipSchema = openStruct({
  branch: Schema.String,
  commit: NullableString,
  ref: Schema.optional(NullableString),
  fetched: optionalBoolean,
  fetchError: optionalString,
  unavailableReason: optionalString,
});

/** `ProjectBaseContainment`: `{ contained: true }` or `{ contained: false, reason }`. */
export const ProjectBaseContainmentSchema = openStruct({
  contained: Schema.Boolean,
  reason: optionalString,
});

// --- Workflows and delegations --------------------------------------------------

/** `Environment` (backend models.ts): a worker environment record. */
export const CoordinatorEnvironmentSchema = openStruct({
  id: Schema.String,
  projectId: optionalString,
  name: optionalString,
  status: optionalString,
  environmentType: optionalString,
});

export const NullableCoordinatorEnvironmentSchema = Schema.NullOr(CoordinatorEnvironmentSchema);

/** `launch_coordinator_environment`: the worker, and whether its delegation opened. */
export const CoordinatorEnvironmentLaunchSchema = openStruct({
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
  ui: openStruct({
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

export const WorkerTerminalLaunchSchema = openStruct({
  environmentId: optionalString,
  tabId: optionalString,
  tabType: optionalString,
  status: optionalString,
  ...receipt,
});

export const WorkerBrowserOpenSchema = openStruct({
  environmentId: optionalString,
  url: optionalString,
  ui: Schema.optional(CoordinatorOpenObject),
  ...receipt,
});

export const WorkerTabEditSchema = openStruct({
  environmentId: optionalString,
  tabId: optionalString,
  operation: optionalString,
  toPaneId: optionalString,
  ...receipt,
});

/** The PR and Resolve tabs' launch answers (`launchWorkerPr`, `launchWorkerResolve`). */
export const WorkerPullRequestLaunchSchema = openStruct({
  status: optionalString,
  tabId: optionalString,
  prUrl: optionalString,
  ...receipt,
});

export const CoordinatorFeaturePlanLaunchSchema = openStruct({
  featureId: optionalString,
  phase: Schema.optional(NullableString),
  reused: optionalBoolean,
  ...receipt,
});

export const CoordinatorFeaturePlanSchema = openStruct({
  featureId: Schema.String,
  title: optionalString,
  status: optionalString,
  summary: optionalString,
  stories: Schema.optional(Schema.Array(openStruct({ id: Schema.String, title: optionalString }))),
  planning: Schema.optional(
    Schema.NullOr(openStruct({ phase: optionalString, failure: optionalString })),
  ),
  lastReply: Schema.optional(NullableString),
  buildPipelineId: optionalString,
});

/** A request the user approves on this machine (root changes, a worker's answer). */
export const CoordinatorApprovalRequestSchema = openStruct({
  environmentId: optionalString,
  tabId: optionalString,
  interactionId: optionalString,
  approvalRequestId: Schema.optional(Schema.Unknown),
  state: optionalString,
  ...receipt,
});

/** `RootChangesListing` (`root-changes.ts`). */
export const RootChangesListingSchema = openStruct({
  files: Schema.Array(CoordinatorOpenObject),
  truncated: Schema.Boolean,
  conflicts: Schema.Finite,
  headCommit: NullableString,
});

/** `ApplyRootChangesOutcome`: the files applied to the worker. */
export const ApplyRootChangesOutcomeSchema = openStruct({
  files: Schema.Array(Schema.String),
});

/** `stopWorkerTurn`'s answer, plus `delegationOpen` from the coordinator's command. */
export const WorkerTurnStopSchema = openStruct({
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
export const WorkerCommandListSchema = openStruct({
  environmentId: optionalString,
  tabId: optionalString,
  agent: optionalString,
  catalogue: Schema.optional(Schema.Unknown),
  commands: Schema.optional(Schema.Array(CoordinatorOpenObject)),
  refresh: Schema.optional(Schema.Unknown),
  nodeId: optionalString,
});

/** `runWorkerCommand`, plus `delegationOpened` from the coordinator's command. */
export const WorkerCommandRunSchema = openStruct({
  command: optionalString,
  startsTurn: optionalBoolean,
  delegationOpened: optionalBoolean,
  ...receipt,
});

/** A build pipeline step restart (`restartHere`), with `followed` on the coordinator's. */
export const PipelineStepRestartSchema = openStruct({
  pipelineId: optionalString,
  restarted: optionalBoolean,
  alreadyRestarted: optionalBoolean,
  step: Schema.optional(Schema.Unknown),
  selection: Schema.optional(CoordinatorOpenObject),
  phase: optionalString,
  error: optionalString,
  followed: optionalBoolean,
  ...receipt,
});

/** A worker tab's goal answers (`set`/`get`/`pause`/`clear_coordinator_worker_goal`). */
export const WorkerGoalSchema = openStruct({
  environmentId: optionalString,
  tabId: optionalString,
  goal: Schema.optional(Schema.NullOr(CoordinatorOpenObject)),
  history: Schema.optional(Schema.Array(CoordinatorOpenObject)),
  wakeOwed: optionalBoolean,
  alreadyStopped: optionalBoolean,
  cleared: optionalBoolean,
  goalId: optionalString,
  replayed: optionalBoolean,
});

/** `SuborkAskResult` (`native-agent-suborks.ts`). */
export const SuborkAskResultSchema = openStruct({
  batchId: optionalString,
  suborks: Schema.optional(Schema.Array(CoordinatorOpenObject)),
  next: optionalString,
});

/** One template's launch view, or the project's template list. */
export const CoordinatorGraphTemplatesSchema = openStruct({
  template: Schema.optional(CoordinatorOpenObject),
  templates: Schema.optional(Schema.Array(CoordinatorOpenObject)),
  total: optionalNumber,
});

/** `start_coordinator_graph_run`: the launch (`GraphLaunchResult`) and its association. */
export const CoordinatorGraphLaunchSchema = openStruct({
  launch: CoordinatorOpenObject,
  associationId: Schema.String,
});

const GraphPosition = openStruct({
  activationKey: Schema.String,
  nodeId: Schema.String,
  error: optionalString,
});

/** `coordinatorGraphRunView`, with `cancelled` on a cancel. */
export const CoordinatorGraphRunViewSchema = openStruct({
  run: CoordinatorOpenObject,
  waitingFor: Schema.Array(GraphPosition),
  failed: Schema.Array(GraphPosition),
  terminal: Schema.Boolean,
  cancelled: optionalBoolean,
});

/** `WorkerAnswerOutcome`: `answered`, or `stale` with a reason. */
export const WorkerAnswerOutcomeSchema = openStruct({
  result: Schema.String,
  reason: optionalString,
});

/** A coordinator's mail: the sent message, or the held project-home request. */
export const CoordinatorMailResultSchema = openStruct({
  id: optionalString,
  placement: optionalString,
  coordinatorDelegationOpened: optionalBoolean,
  projectHome: optionalBoolean,
});

/** `send_approved_project_home_message`: `sent`, or `stale` with a reason. */
export const ApprovedProjectHomeMessageSchema = openStruct({
  result: Schema.String,
  reason: optionalString,
  messageId: optionalString,
  placement: optionalString,
});
