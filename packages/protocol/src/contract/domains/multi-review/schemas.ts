/**
 * Result shapes of the `multi-review` commands (plan item 7007), over the
 * protocol's Multi Review and review validation types (`multi-review.ts`,
 * `review-validation.ts`) and the backend's stored envelope
 * (`PersistedMultiReviewWorkflow` without its controller lease).
 *
 * Records are {@link modelRecord}s: the fields that identify a record and the
 * ones a reader branches on are checked, and every other key passes through,
 * typed as the protocol's interface.
 *
 * **The workflow guard is not used here**, for the build pipeline's reason
 * (`../pipelines/schemas.ts`): `isMultiReviewWorkflow` refuses fields an older
 * client does not know, and the renderer runs it only after rewriting the
 * Address Findings vocabulary (`canonicalMultiReview`). The stored `snapshot`
 * stays `unknown`, as the model types it.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  MultiReviewReviewerHistoryPage,
  MultiReviewReviewerTranscript,
  MultiReviewStepTranscript,
  MultiReviewWorkflow,
} from "../../../multi-review.js";
import type {
  ReviewValidationOutput,
  ReviewValidationOutputStream,
  ReviewValidationRun,
} from "../../../review-validation.js";
import type { Mutable } from "effect/Types";
import {
  asModel,
  modelRecord,
  mutableArray,
  opaqueRecord,
  openRecord,
} from "../../model-schema.js";
import { conditionalSnapshotOf, UnchangedRevisionSchema } from "../pipelines/schemas.js";

const optionalString = Schema.optional(Schema.String);
const optionalBoolean = Schema.optional(Schema.Boolean);
/** Any JSON object, nothing checked (`Schema.Record`; not `model-schema.ts`'s `OpenObject`). */
const OpaqueObject = opaqueRecord<Record<string, unknown>>();
const Messages = mutableArray(Schema.Unknown);

/**
 * `MultiReviewWorkflow`: the snapshot the lifecycle commands answer, without
 * its controller fence. `id` is always written; the rest is optional because
 * the supervisor is faked in tests with partial records.
 */
export const MultiReviewWorkflowSchema = modelRecord<MultiReviewWorkflow>()({
  id: Schema.String,
  version: Schema.optional(Schema.Finite),
  controller: optionalString,
  environmentId: optionalString,
  projectId: optionalString,
  targetBranch: optionalString,
  phase: optionalString,
  engine: optionalString,
  reviewers: Schema.optional(Schema.Array(OpaqueObject)),
});

/**
 * The stored envelope of one workflow as the reads answer it
 * (`PersistedMultiReviewWorkflow` without `controllerLease`, which the
 * backend strips with the snapshot's fence token). The model itself (plan
 * item 7010): storage writes every field, so they are required; the web's
 * `PersistedWorkflowRecord` is a view of this type and the backend's stored
 * record adds the lease to it. `snapshot` is the `MultiReviewWorkflow`,
 * `unknown` here; absent only on a record stored without one, which is
 * answered as stored.
 */
export const MultiReviewWorkflowRecordSchema = openRecord({
  version: Schema.Finite,
  id: Schema.String,
  environmentId: Schema.String,
  snapshot: Schema.optional(Schema.Unknown),
  updatedAt: Schema.String,
  revision: Schema.Finite,
});
export type MultiReviewWorkflowRecord = Mutable<typeof MultiReviewWorkflowRecordSchema.Type>;

/** `get_multi_review_workflow`: `null`, `unchanged` at `knownRevision`, or the record. */
export const GetMultiReviewWorkflowResultSchema = Schema.Union([
  Schema.Null,
  UnchangedRevisionSchema,
  MultiReviewWorkflowRecordSchema,
]);

/** `list_multi_review_workflows`: the records, or a manifest-conditional snapshot of them. */
export const ListMultiReviewWorkflowsResultSchema = Schema.Union([
  mutableArray(MultiReviewWorkflowRecordSchema),
  conditionalSnapshotOf(mutableArray(MultiReviewWorkflowRecordSchema)),
]);

/**
 * A reviewer's bounded transcript tail (`get_multi_review_reviewer_transcript`).
 * Past its identity and messages the fields are optional, because the
 * supervisor is faked in tests with partial answers.
 */
export const MultiReviewReviewerTranscriptSchema = modelRecord<MultiReviewReviewerTranscript>()({
  workflowId: Schema.String,
  reviewerId: Schema.String,
  workflowPhase: optionalString,
  agent: optionalString,
  model: optionalString,
  status: optionalString,
  messages: Messages,
  transcript: optionalString,
  sourceToken: optionalString,
  truncated: optionalBoolean,
  historyCursor: optionalString,
  historyEpoch: optionalString,
  revisedMessages: Schema.optional(Messages),
});

/** A preparation, consolidation or Address Findings session's tail. */
export const MultiReviewStepTranscriptSchema = modelRecord<MultiReviewStepTranscript>()({
  workflowId: Schema.String,
  step: Schema.String,
  workflowPhase: optionalString,
  session: optionalString,
  sessionStep: optionalString,
  agent: optionalString,
  model: optionalString,
  messages: Messages,
  transcript: optionalString,
  sourceToken: optionalString,
  truncated: optionalBoolean,
});

/**
 * `get_multi_review_reviewer_history_page`. The renderer still checks the
 * page's bounds (`isMultiReviewReviewerHistoryPage`) after decoding.
 */
export const MultiReviewReviewerHistoryPageSchema = asModel<MultiReviewReviewerHistoryPage>(
  Schema.Union([
    Schema.Struct({
      status: Schema.Literal("page"),
      messages: Messages,
      historyEpoch: Schema.String,
      nextCursor: optionalString,
      complete: Schema.Boolean,
      truncated: Schema.Boolean,
    }),
    Schema.Struct({ status: Schema.Literal("expired"), reason: Schema.String }),
  ]),
);

/** `ReviewValidationRun`: an environment-owned validation process's projection. */
export const ReviewValidationRunSchema = modelRecord<ReviewValidationRun>()({
  id: Schema.String,
  plan: Schema.optional(OpaqueObject),
  status: Schema.String,
  startedAt: optionalString,
  completedAt: optionalString,
  error: optionalString,
  results: Schema.optional(Schema.Array(OpaqueObject)),
});

const OutputStreamSchema = modelRecord<ReviewValidationOutputStream>()({
  contentBase64: Schema.String,
  totalBytes: Schema.Finite,
  startOffset: Schema.Finite,
  anchor: optionalString,
  mode: optionalString,
});

/** `get_review_validation_output`: one command's bounded output tails. */
export const ReviewValidationOutputSchema = modelRecord<ReviewValidationOutput>()({
  resultId: Schema.String,
  status: Schema.String,
  stdout: Schema.NullOr(OutputStreamSchema),
  stderr: Schema.NullOr(OutputStreamSchema),
});
