/**
 * Result shapes of the `kanban` commands (plan item 7008), derived from the
 * backend's model types (`KanbanTask`, `ProjectNotes`, `FeaturePlan` in
 * `apps/backend/src/core/storage-shared-core.ts`, the Linear types in
 * `apps/backend/src/core/linear.ts`) and the protocol's
 * `FeaturePlanningRecord` (`feature-planning.ts`), `TicketSections`
 * (`ticket-sections.ts`) and `ConditionalResourceSnapshot`
 * (`resource-events.ts`). Plan item 7010 converges the models on these.
 *
 * Records are **open structs** (`openRecord`, `modelRecord`): the listed
 * fields are checked and typed, every other key the backend sends is kept, so
 * a domain client's tolerant decode never strips a field the renderer reads.
 * A record's identity (`id`, the notes' `projectId`, the planning exchange's
 * `operationId`/`featureId`/`phase`) and the connection's two flags are
 * required; the other fields are optional (a present one is still checked),
 * as in 7001: the storage behind these commands is faked in tests with
 * partial records and results are validated there. Which fields are always
 * present converges with the models in 7010. Values a newer backend may
 * extend (statuses, kinds, PR states) are `Schema.String`, so an older client
 * still reads them.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { FeaturePlanningRecord } from "../../../feature-planning.js";
import type { TicketLabelDefinition, TicketLabelSummary } from "../../../ticket-labels.js";
import { modelRecord, mutableArray, OpenObject, openRecord } from "../../model-schema.js";

const optionalString = Schema.optional(Schema.String);
const optionalNumber = Schema.optional(Schema.Finite);

/**
 * `ConditionalResourceSnapshot<T>` (resource-events.ts): the answer to a read
 * that sent `knownManifestGeneration` and `knownResourceRevision`.
 */
function conditionalSnapshot<S extends Schema.Top>(snapshot: S) {
  return Schema.Union([
    Schema.Struct({
      status: Schema.Literal("unchanged"),
      generation: Schema.String,
      revision: Schema.String,
    }),
    Schema.Struct({
      status: Schema.Literal("changed"),
      generation: Schema.String,
      revision: Schema.String,
      snapshot,
    }),
  ]);
}

/** A plain read, or its conditional answer when the caller sent a known revision. */
export function snapshotRead<S extends Schema.Top>(snapshot: S) {
  return Schema.Union([snapshot, conditionalSnapshot(snapshot)]);
}

// --- Kanban tickets -----------------------------------------------------------

/** `KanbanComment`. */
export const KanbanCommentSchema = openRecord({
  id: Schema.String,
  text: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
}).annotate({ identifier: "KanbanComment" });

/** `KanbanImage`: the stored image's metadata; its bytes are `get_kanban_image_data`. */
export const KanbanImageSchema = openRecord({
  id: Schema.String,
  filename: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
}).annotate({ identifier: "KanbanImage" });

/** `KanbanTask`: one ticket on this node's board. */
export const KanbanTaskSchema = openRecord({
  id: Schema.String,
  projectId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  // Text mirrors of `sections`, kept for readers that predate sections.
  description: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.optional(Schema.String),
  // `TicketKind`; absent on tickets written before kinds (a feature ticket).
  kind: optionalString,
  // `TicketSections`; absent on legacy rows (derived from the mirrors).
  sections: Schema.optional(OpenObject),
  sectionsBasis: optionalString,
  // Label names in the order they were added (`ticket-labels.ts`); absent when it has none.
  labels: Schema.optional(mutableArray(Schema.String)),
  // `KanbanStatus`.
  status: Schema.optional(Schema.String),
  comments: Schema.optional(mutableArray(KanbanCommentSchema)),
  images: Schema.optional(mutableArray(KanbanImageSchema)),
  createdAt: Schema.optional(Schema.String),
  order: optionalNumber,
  environmentId: optionalString,
  buildPipelineId: optionalString,
  featureBuildRequestHash: optionalString,
  prUrl: optionalString,
  // `PrState`.
  prState: optionalString,
  prMergeCommented: Schema.optional(Schema.Boolean),
  // The merged pull request that moved the ticket to done (`kanban-merge-closure.ts`).
  prMergeDoneUrl: optionalString,
  // `TicketSyncMeta` (`ticket-sync.ts`); absent on rows never synced.
  sync: Schema.optional(OpenObject),
}).annotate({ identifier: "KanbanTask" });

export const KanbanTaskListSchema = mutableArray(KanbanTaskSchema);

/** `TicketLabelSummary` (`ticket-labels.ts`): one label a project offers, with its ticket count. */
export const TicketLabelSummarySchema = modelRecord<TicketLabelSummary>()({
  name: Schema.String,
  color: optionalString,
  description: optionalString,
  // Absent for a label only tickets carry.
  createdAt: optionalString,
  ticketCount: Schema.Finite,
}).annotate({ identifier: "TicketLabelSummary" });

export const TicketLabelSummaryListSchema = mutableArray(TicketLabelSummarySchema);

/** `TicketLabelDefinition` (`ticket-labels.ts`): one label in a project's catalogue. */
export const TicketLabelDefinitionSchema = modelRecord<TicketLabelDefinition>()({
  name: Schema.String,
  color: optionalString,
  description: optionalString,
  createdAt: Schema.String,
}).annotate({ identifier: "TicketLabelDefinition" });

/** `create_kanban_label`: the catalogue entry, and whether this call added it. */
export const KanbanLabelCreateResultSchema = Schema.Struct({
  label: TicketLabelDefinitionSchema,
  created: Schema.Boolean,
});

/** `close_kanban_task_for_merged_pr`: whether the ticket moved to done. */
export const KanbanMergeClosureResultSchema = Schema.Struct({ closed: Schema.Boolean });

/** `ProjectNotes`. */
export const ProjectNotesSchema = openRecord({
  projectId: Schema.String,
  content: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
}).annotate({ identifier: "ProjectNotes" });

// --- Feature plans and planning -------------------------------------------------

/** `FeaturePlanMessage`. */
export const FeaturePlanMessageSchema = openRecord({
  id: Schema.String,
  // `user`, `assistant` or `system`.
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  modelId: optionalString,
  // `pending`, `applied` or `superseded`.
  stateApplication: optionalString,
}).annotate({ identifier: "FeaturePlanMessage" });

/** `FeatureStoryCard`. */
export const FeatureStoryCardSchema = openRecord({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.optional(mutableArray(Schema.String)),
  messages: Schema.optional(mutableArray(FeaturePlanMessageSchema)),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
}).annotate({ identifier: "FeatureStoryCard" });

/** `FeaturePlanningRecord` (`feature-planning.ts`): one backend-owned planning exchange. */
export const FeaturePlanningRecordSchema = modelRecord<FeaturePlanningRecord>()({
  version: Schema.optional(Schema.Finite),
  operationId: Schema.String,
  featureId: Schema.String,
  projectId: Schema.optional(Schema.String),
  // `feature` or `story`.
  kind: Schema.optional(Schema.String),
  storyId: optionalString,
  userMessage: Schema.optional(Schema.String),
  // `FeaturePlanningPhase`.
  phase: Schema.String,
  failure: Schema.optional(OpenObject),
  startedAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  backendRevision: Schema.optional(Schema.Finite),
}).annotate({ identifier: "FeaturePlanningRecord" });

/** `FeaturePlan`. */
export const FeaturePlanSchema = openRecord({
  id: Schema.String,
  projectId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  // `FeaturePlanStatus`.
  status: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  messages: Schema.optional(mutableArray(FeaturePlanMessageSchema)),
  stories: Schema.optional(mutableArray(FeatureStoryCardSchema)),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  order: optionalNumber,
  codexEnvironmentId: optionalString,
  codexSessionId: optionalString,
  buildTaskId: optionalString,
  buildPipelineId: optionalString,
  planning: Schema.optional(FeaturePlanningRecordSchema),
}).annotate({ identifier: "FeaturePlan" });

export const FeaturePlanListSchema = mutableArray(FeaturePlanSchema);

/** `claim_feature_plan_build`: whether this call reserved the plan's build. */
export const FeaturePlanBuildClaimSchema = Schema.Struct({
  claimed: Schema.Boolean,
  feature: FeaturePlanSchema,
}).annotate({ identifier: "FeaturePlanBuildClaim" });

// --- Linear ---------------------------------------------------------------------

/** `LinearViewer`: who the stored key belongs to. Never the key. */
export const LinearViewerSchema = openRecord({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  email: optionalString,
}).annotate({ identifier: "LinearViewer" });

/** `LinearConnectionStatus`. */
export const LinearConnectionStatusSchema = openRecord({
  connected: Schema.Boolean,
  hasToken: Schema.Boolean,
  viewer: Schema.optional(LinearViewerSchema),
  error: optionalString,
  /**
   * A short SHA-256 fingerprint of the stored key, so machines can tell
   * whether they hold the same key. Never the key, and not enough to rebuild it.
   */
  keyFingerprint: optionalString,
  connectedAt: optionalString,
}).annotate({ identifier: "LinearConnectionStatus" });

const linearIssueFields = {
  id: Schema.String,
  identifier: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  statusType: optionalString,
  statusPosition: optionalNumber,
  sortOrder: optionalNumber,
  priority: optionalNumber,
  prioritySortOrder: optionalNumber,
  updatedAt: Schema.optional(Schema.String),
  createdAt: optionalString,
  url: optionalString,
  teamKey: optionalString,
  teamName: optionalString,
  assigneeName: optionalString,
  priorityLabel: optionalString,
};

/** `LinearIssueListItem`. */
export const LinearIssueListItemSchema = openRecord(linearIssueFields).annotate({
  identifier: "LinearIssueListItem",
});

/** `LinearIssueComment`. */
export const LinearIssueCommentSchema = openRecord({
  id: Schema.String,
  body: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  updatedAt: optionalString,
  authorName: optionalString,
}).annotate({ identifier: "LinearIssueComment" });

/** `LinearIssueDetail`. */
export const LinearIssueDetailSchema = openRecord({
  ...linearIssueFields,
  description: Schema.optional(Schema.String),
  creatorName: optionalString,
  projectName: optionalString,
  cycleName: optionalString,
  labels: Schema.optional(mutableArray(Schema.String)),
  comments: Schema.optional(mutableArray(LinearIssueCommentSchema)),
}).annotate({ identifier: "LinearIssueDetail" });

/** `LinearCompletionCommentResult`, or the earlier post a retry found. */
export const LinearCompletionCommentResultSchema = openRecord({
  // `posted` or `already-posted`.
  status: Schema.String,
  commentId: Schema.optional(Schema.String),
  postedAt: optionalString,
}).annotate({ identifier: "LinearCompletionCommentResult" });

// --- Linear boards ---------------------------------------------------------------

/**
 * The Linear board one Orkestrator project uses: a team, optionally narrowed
 * to one Linear project in it. `key` is `repo:<repositoryHint>` for a project
 * with a Git remote (the same on every machine, so it syncs) or
 * `project:<projectId>` for one without (this machine only). A cleared link
 * is kept as a tombstone (`cleared: true`) so the clear syncs too.
 */
export const LinearBoardLinkSchema = openRecord({
  key: Schema.String,
  repositoryHint: optionalString,
  projectId: optionalString,
  teamId: Schema.optional(Schema.String),
  teamKey: optionalString,
  teamName: optionalString,
  linearProjectId: optionalString,
  linearProjectName: optionalString,
  updatedAt: Schema.String,
  cleared: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "LinearBoardLink" });

/** `get_linear_board_link`: the project's link, absent when it has none. */
export const LinearBoardLinkResultSchema = Schema.Struct({
  link: Schema.optional(LinearBoardLinkSchema),
}).annotate({ identifier: "LinearBoardLinkResult" });

/** A Linear project inside a team, for the board picker. */
export const LinearTeamProjectSchema = openRecord({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  state: optionalString,
}).annotate({ identifier: "LinearTeamProject" });

/** A Linear team (one board) and its projects, for the board picker. */
export const LinearTeamSchema = openRecord({
  id: Schema.String,
  key: optionalString,
  name: Schema.optional(Schema.String),
  projects: Schema.optional(mutableArray(LinearTeamProjectSchema)),
}).annotate({ identifier: "LinearTeam" });

/** The ids a write to a board can use: its workflow states, labels and members. */
export const LinearBoardOptionsSchema = openRecord({
  teamId: Schema.String,
  states: Schema.optional(
    mutableArray(
      openRecord({
        id: Schema.String,
        name: optionalString,
        type: optionalString,
        position: optionalNumber,
      }),
    ),
  ),
  labels: Schema.optional(
    mutableArray(openRecord({ id: Schema.String, name: optionalString, color: optionalString })),
  ),
  members: Schema.optional(
    mutableArray(
      openRecord({
        id: Schema.String,
        name: optionalString,
        displayName: optionalString,
        email: optionalString,
      }),
    ),
  ),
}).annotate({ identifier: "LinearBoardOptions" });

/** Linear's view of one other machine, as the command node last read it. Never a key. */
export const LinearNodeConnectionSchema = openRecord({
  nodeId: Schema.String,
  nodeName: optionalString,
  connected: Schema.Boolean,
  viewerName: optionalString,
  keyFingerprint: optionalString,
  readAt: optionalString,
}).annotate({ identifier: "LinearNodeConnection" });

/** A disconnect, kept so machines that were offline clear the same key later. */
export const LinearRevocationSchema = openRecord({
  keyFingerprint: Schema.String,
  revokedAt: Schema.String,
}).annotate({ identifier: "LinearRevocation" });
