/**
 * Result shapes of the `kanban` commands (plan item 7008), derived from the
 * backend's model types (`KanbanTask`, `ProjectNotes`, `FeaturePlan` in
 * `apps/backend/src/core/storage-shared-core.ts`, the Linear types in
 * `apps/backend/src/core/linear.ts`) and the protocol's
 * `FeaturePlanningRecord` (`feature-planning.ts`), `TicketSections`
 * (`ticket-sections.ts`) and `ConditionalResourceSnapshot`
 * (`resource-events.ts`). Plan item 7010 converges the models on these.
 *
 * Records are **open structs** (`openStruct`, `modelRecord`): the listed
 * fields are checked and typed, every other key the backend sends is kept, so
 * a domain client's tolerant decode never strips a field the renderer reads.
 * Fields every stored record has (ids, the ticket's text mirrors, its status,
 * comments and images) are required; fields older rows or older backends may
 * omit are optional. Values a newer backend may extend (statuses, kinds, PR
 * states) are `Schema.String`, so an older client still reads them.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { FeaturePlanningRecord } from "../../../feature-planning.js";
import { modelRecord } from "../../model-schema.js";
import { OpenObject, openStruct } from "../native-sessions/schemas.js";

const optionalString = Schema.optional(Schema.String);
const optionalNumber = Schema.optional(Schema.Finite);

/** A mutable array, so the inferred type matches the models' `T[]`. */
function mutableArray<S extends Schema.Top>(item: S) {
  return Schema.mutable(Schema.Array(item));
}

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
export const KanbanCommentSchema = openStruct({
  id: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
}).annotate({ identifier: "KanbanComment" });

/** `KanbanImage`: the stored image's metadata; its bytes are `get_kanban_image_data`. */
export const KanbanImageSchema = openStruct({
  id: Schema.String,
  filename: Schema.String,
  createdAt: Schema.String,
}).annotate({ identifier: "KanbanImage" });

/** `KanbanTask`: one ticket on this node's board. */
export const KanbanTaskSchema = openStruct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  // Text mirrors of `sections`, kept for readers that predate sections.
  description: Schema.String,
  acceptanceCriteria: Schema.String,
  // `TicketKind`; absent on tickets written before kinds (a feature ticket).
  kind: optionalString,
  // `TicketSections`; absent on legacy rows (derived from the mirrors).
  sections: Schema.optional(OpenObject),
  sectionsBasis: optionalString,
  // `KanbanStatus`.
  status: Schema.String,
  comments: mutableArray(KanbanCommentSchema),
  images: mutableArray(KanbanImageSchema),
  createdAt: Schema.String,
  order: optionalNumber,
  environmentId: optionalString,
  buildPipelineId: optionalString,
  featureBuildRequestHash: optionalString,
  prUrl: optionalString,
  // `PrState`.
  prState: optionalString,
  prMergeCommented: Schema.optional(Schema.Boolean),
  // `TicketSyncMeta` (`ticket-sync.ts`); absent on rows never synced.
  sync: Schema.optional(OpenObject),
}).annotate({ identifier: "KanbanTask" });

export const KanbanTaskListSchema = mutableArray(KanbanTaskSchema);

/** `ProjectNotes`. */
export const ProjectNotesSchema = openStruct({
  projectId: Schema.String,
  content: Schema.String,
  updatedAt: Schema.String,
}).annotate({ identifier: "ProjectNotes" });

// --- Feature plans and planning -------------------------------------------------

/** `FeaturePlanMessage`. */
export const FeaturePlanMessageSchema = openStruct({
  id: Schema.String,
  // `user`, `assistant` or `system`.
  role: Schema.String,
  content: Schema.String,
  createdAt: Schema.String,
  modelId: optionalString,
  // `pending`, `applied` or `superseded`.
  stateApplication: optionalString,
}).annotate({ identifier: "FeaturePlanMessage" });

/** `FeatureStoryCard`. */
export const FeatureStoryCardSchema = openStruct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  acceptanceCriteria: mutableArray(Schema.String),
  messages: mutableArray(FeaturePlanMessageSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotate({ identifier: "FeatureStoryCard" });

/** `FeaturePlanningRecord` (`feature-planning.ts`): one backend-owned planning exchange. */
export const FeaturePlanningRecordSchema = modelRecord<FeaturePlanningRecord>()({
  version: Schema.Finite,
  operationId: Schema.String,
  featureId: Schema.String,
  projectId: Schema.String,
  // `feature` or `story`.
  kind: Schema.String,
  storyId: optionalString,
  userMessage: Schema.String,
  // `FeaturePlanningPhase`.
  phase: Schema.String,
  failure: Schema.optional(OpenObject),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  backendRevision: Schema.Finite,
}).annotate({ identifier: "FeaturePlanningRecord" });

/** `FeaturePlan`. */
export const FeaturePlanSchema = openStruct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  // `FeaturePlanStatus`.
  status: Schema.String,
  summary: Schema.String,
  messages: mutableArray(FeaturePlanMessageSchema),
  stories: mutableArray(FeatureStoryCardSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
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
export const LinearViewerSchema = openStruct({
  id: Schema.String,
  name: Schema.String,
  email: optionalString,
}).annotate({ identifier: "LinearViewer" });

/** `LinearConnectionStatus`. */
export const LinearConnectionStatusSchema = openStruct({
  connected: Schema.Boolean,
  hasToken: Schema.Boolean,
  viewer: Schema.optional(LinearViewerSchema),
  error: optionalString,
}).annotate({ identifier: "LinearConnectionStatus" });

const linearIssueFields = {
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  status: Schema.String,
  statusType: optionalString,
  statusPosition: optionalNumber,
  sortOrder: optionalNumber,
  priority: optionalNumber,
  prioritySortOrder: optionalNumber,
  updatedAt: Schema.String,
  createdAt: optionalString,
  url: optionalString,
  teamKey: optionalString,
  teamName: optionalString,
  assigneeName: optionalString,
  priorityLabel: optionalString,
};

/** `LinearIssueListItem`. */
export const LinearIssueListItemSchema = openStruct(linearIssueFields).annotate({
  identifier: "LinearIssueListItem",
});

/** `LinearIssueComment`. */
export const LinearIssueCommentSchema = openStruct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: optionalString,
  authorName: optionalString,
}).annotate({ identifier: "LinearIssueComment" });

/** `LinearIssueDetail`. */
export const LinearIssueDetailSchema = openStruct({
  ...linearIssueFields,
  description: Schema.String,
  creatorName: optionalString,
  projectName: optionalString,
  cycleName: optionalString,
  labels: mutableArray(Schema.String),
  comments: mutableArray(LinearIssueCommentSchema),
}).annotate({ identifier: "LinearIssueDetail" });

/** `LinearCompletionCommentResult`, or the earlier post a retry found. */
export const LinearCompletionCommentResultSchema = openStruct({
  // `posted` or `already-posted`.
  status: Schema.String,
  commentId: Schema.String,
  postedAt: optionalString,
}).annotate({ identifier: "LinearCompletionCommentResult" });
