/**
 * Result shapes of the `pipelines` commands (plan item 7007), over the
 * protocol's build pipeline types (`build-pipeline.ts`, `feature-build.ts`,
 * `workflow-results.ts`) and the backend's stored envelope
 * (`PersistedBuildPipeline`, `apps/backend/src/core/models.ts`).
 *
 * Records are {@link modelRecord}s: the fields that identify a record and the
 * ones a reader branches on are checked, and every other key passes through,
 * typed as the protocol's interface. Deeper parts (sessions, reviewer
 * fan-out, review packages) stay open objects.
 *
 * **The build pipeline guard is not used here.** `isBuildPipeline` refuses a
 * reviewer key an older client does not know, and the renderer runs it only
 * after rewriting the Rework and Address Findings vocabulary
 * (`canonicalBuildPipeline`, `workflow-vocabulary.ts`). Running it inside a
 * decode, before that rewrite, would refuse a newer backend's snapshot that
 * today's renderer reads. The stored `snapshot` is `unknown` in the model
 * and stays so: the renderer's stores canonicalise and guard it.
 *
 * Values a newer backend may extend (phases, agents, deliveries) are
 * `Schema.String` unless a union branches on them.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  BuildPipeline,
  BuildPipelineCodeRewindPreview,
  PipelineQueuedSteerDelivery,
} from "../../../build-pipeline.js";
import type {
  CreateFeatureBuildResult,
  StartFeaturePlanBuildResult,
} from "../../../feature-build.js";
import type { WorkflowResultToolsSettings } from "../../../workflow-results.js";
import { modelRecord, opaqueRecord, type ModelSchema } from "../../model-schema.js";

/** A list typed as a mutable array, as the protocol's interfaces declare lists. */
export function listOf<S extends Schema.Top>(item: S) {
  return Schema.mutable(Schema.Array(item));
}

const optionalString = Schema.optional(Schema.String);
const optionalNumber = Schema.optional(Schema.Finite);
const OpenObject = opaqueRecord<Record<string, unknown>>();

/** `schema`, typed as the protocol's own type `T` (literal unions, `?:` fields). */
function asModel<T>(schema: Schema.Top): ModelSchema<T> {
  return schema as unknown as ModelSchema<T>;
}

// --------------------------------------------------------------- pipelines

/**
 * `BuildPipeline`: the snapshot the lifecycle commands answer. Every field is
 * optional because the supervisor behind these commands is faked in tests
 * with partial records; a present field is still checked. Which fields are
 * always present converges with the models in plan item 7010.
 */
export const BuildPipelineSchema = modelRecord<BuildPipeline>()({
  id: optionalString,
  taskId: optionalString,
  projectId: optionalString,
  environmentId: optionalString,
  environmentType: optionalString,
  agentType: optionalString,
  phase: optionalString,
  sessions: Schema.optional(Schema.Array(OpenObject)),
  currentSessionIndex: optionalNumber,
  iteration: optionalNumber,
  maxIterations: optionalNumber,
  error: optionalString,
});

/**
 * The stored envelope of one pipeline (`PersistedBuildPipeline`), as the reads
 * answer it: transcript bodies are never inline. `snapshot` is the
 * `BuildPipeline`, typed `unknown` by the model (a record written by an older
 * build may predate fields the current guard needs). Storage writes every
 * field; past `id` the schema leaves them optional because storage is faked in
 * tests with partial records.
 */
export interface BuildPipelineRecord {
  version: number;
  id: string;
  projectId: string;
  environmentId: string;
  snapshot: unknown;
  updatedAt: string;
  activityEndedAt?: string;
  revision: number;
}

export const BuildPipelineRecordSchema = modelRecord<BuildPipelineRecord>()({
  version: optionalNumber,
  id: Schema.String,
  projectId: optionalString,
  environmentId: optionalString,
  snapshot: Schema.optional(Schema.Unknown),
  updatedAt: optionalString,
  activityEndedAt: optionalString,
  revision: optionalNumber,
});

/** `{ unchanged: true, revision }`: the caller's copy is current. */
export const UnchangedRevisionSchema = Schema.Struct({
  unchanged: Schema.Literal(true),
  revision: Schema.Finite,
});

/** One session's transcript window in a conditional `get_build_pipeline`. */
export interface BuildPipelineMessagePatch {
  sessionKey: string;
  baseRevision?: number;
  baseCount?: number;
  startIndex: number;
  revision: number;
  messages: unknown[];
  unavailable?: true;
  deferred?: true;
  complete?: false;
}

export const BuildPipelineMessagePatchSchema = modelRecord<BuildPipelineMessagePatch>()({
  sessionKey: Schema.String,
  baseRevision: optionalNumber,
  baseCount: optionalNumber,
  startIndex: Schema.Finite,
  revision: Schema.Finite,
  messages: listOf(Schema.Unknown),
  unavailable: Schema.optional(Schema.Literal(true)),
  deferred: Schema.optional(Schema.Literal(true)),
  complete: Schema.optional(Schema.Literal(false)),
});

/**
 * `get_build_pipeline`: `null` for an unknown id; `unchanged` when the caller
 * named the current revision (and, with `knownSessions`, held every body);
 * with `knownSessions`, the record plus the transcript windows it lacks;
 * otherwise the record.
 */
export const GetBuildPipelineResultSchema = Schema.Union([
  Schema.Null,
  UnchangedRevisionSchema,
  Schema.Struct({
    unchanged: Schema.Literal(false),
    record: BuildPipelineRecordSchema,
    messagePatches: listOf(BuildPipelineMessagePatchSchema),
  }),
  BuildPipelineRecordSchema,
]);

/** `ConditionalResourceSnapshot<T>` (resource-events.ts), for the manifest-conditional lists. */
export function conditionalSnapshotOf<S extends Schema.Top>(snapshot: S) {
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

/** `list_build_pipelines` with `knownRevisions`: every id, and the records that changed. */
export const BuildPipelineDeltaSchema = Schema.Struct({
  ids: listOf(Schema.String),
  records: listOf(BuildPipelineRecordSchema),
});

const BuildPipelineListSchema = Schema.Union([
  listOf(BuildPipelineRecordSchema),
  BuildPipelineDeltaSchema,
]);

/**
 * `list_build_pipelines`: the records, the delta for `knownRevisions`, or
 * either inside a manifest-conditional snapshot (`knownManifestGeneration`).
 */
export const ListBuildPipelinesResultSchema = Schema.Union([
  listOf(BuildPipelineRecordSchema),
  BuildPipelineDeltaSchema,
  conditionalSnapshotOf(BuildPipelineListSchema),
]);

/** `steer_build_pipeline`: `queued` when there was no live turn to steer. */
export const SteerBuildPipelineResultSchema = asModel<{
  pipeline: BuildPipeline;
  delivery: "steered" | "queued";
}>(Schema.Struct({ pipeline: BuildPipelineSchema, delivery: Schema.String }));

/** `steer_queued_build_pipeline_message`. */
export const SteerQueuedBuildPipelineMessageResultSchema = asModel<{
  pipeline: BuildPipeline;
  delivery: PipelineQueuedSteerDelivery;
  notice?: string;
}>(
  Schema.Struct({
    pipeline: BuildPipelineSchema,
    delivery: Schema.String,
    notice: optionalString,
  }),
);

/** `remove_queued_build_pipeline_message`: `removed` is false when it already left the queue. */
export const RemoveQueuedBuildPipelineMessageResultSchema = Schema.Struct({
  pipeline: BuildPipelineSchema,
  removed: Schema.Boolean,
});

/**
 * "Rewind code to here": what a reset would drop (build pipelines and Multi
 * Review). Optional for the reason {@link BuildPipelineSchema} is.
 */
export const CodeRewindPreviewSchema = modelRecord<BuildPipelineCodeRewindPreview>()({
  pipelineId: optionalString,
  sessionKey: optionalString,
  iteration: optionalNumber,
  targetCommit: optionalString,
  head: optionalString,
  commits: Schema.optional(listOf(Schema.Struct({ sha: Schema.String, subject: Schema.String }))),
  commitCount: optionalNumber,
  upstream: Schema.optional(Schema.Struct({ ref: Schema.String, droppedCommits: Schema.Finite })),
  pullRequest: Schema.optional(Schema.Struct({ url: Schema.String, state: Schema.String })),
  uncommittedPaths: Schema.optional(listOf(Schema.String)),
  blocked: optionalString,
});

/** `import_legacy_build_pipelines`. */
export const ImportLegacyBuildPipelinesResultSchema = Schema.Struct({
  importedIds: listOf(Schema.String),
  skipped: Schema.Finite,
});

/** `create_feature_build`: the ticket and pipeline it made (or a retry's same pair). */
export const CreateFeatureBuildResultSchema = modelRecord<CreateFeatureBuildResult>()({
  taskId: Schema.String,
  pipelineId: Schema.String,
  environmentId: optionalString,
});

/** `start_feature_plan_build`. */
export const StartFeaturePlanBuildResultSchema = modelRecord<StartFeaturePlanBuildResult>()({
  featureId: Schema.String,
  taskId: Schema.String,
  pipeline: BuildPipelineSchema,
  reused: Schema.Boolean,
});

/** One pipeline or Multi Review worker's read window (`get_build_pipeline_worker_transcript`). */
export interface PipelineWorkerTranscript {
  environmentId: string;
  tabId: string;
  /** A build pipeline worker's pipeline. */
  pipelineId?: string;
  /** A Multi Review reviewer's workflow. */
  workflowId?: string;
  worker?: Record<string, unknown>;
  agent?: string;
  messages: unknown[];
  messageWindow?: { startIndex: number; messageCount: number; complete?: boolean };
  revision?: number;
  checkpointedAt?: string;
  error?: string;
}

export const PipelineWorkerTranscriptSchema = modelRecord<PipelineWorkerTranscript>()({
  environmentId: Schema.String,
  tabId: Schema.String,
  pipelineId: optionalString,
  workflowId: optionalString,
  worker: Schema.optional(OpenObject),
  agent: optionalString,
  messages: listOf(Schema.Unknown),
  messageWindow: Schema.optional(
    Schema.Struct({
      startIndex: Schema.Finite,
      messageCount: Schema.Finite,
      complete: Schema.optional(Schema.Boolean),
    }),
  ),
  revision: optionalNumber,
  checkpointedAt: optionalString,
  error: optionalString,
});

// --------------------------------------------------------------- workflow results

/** `WorkflowResultToolsSettings`: the backend-owned tool-mode rollout. */
export const WorkflowResultToolsSettingsSchema = asModel<WorkflowResultToolsSettings>(
  Schema.Struct({
    enabled: Schema.Boolean,
    providers: listOf(Schema.String),
    kinds: listOf(Schema.String),
  }),
);

const DurationSummarySchema = Schema.Struct({
  count: Schema.Finite,
  totalMs: Schema.Finite,
  maxMs: Schema.Finite,
});

/** `get_workflow_result_metrics`: bounded, content-free counters and the current rollout. */
export const WorkflowResultMetricsResultSchema = Schema.Struct({
  metrics: Schema.Struct({
    counters: Schema.Record(Schema.String, Schema.Finite),
    durations: Schema.Record(Schema.String, DurationSummarySchema),
    gauges: Schema.Record(Schema.String, Schema.Finite),
    droppedSeries: Schema.Finite,
  }),
  rollout: Schema.NullOr(WorkflowResultToolsSettingsSchema),
});
