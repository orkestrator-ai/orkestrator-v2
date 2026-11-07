/**
 * Result shapes of the `git` commands (plan item 7006): the changes ledger
 * (`@orkestrator/protocol/change-resources`), diff stats and diff bases
 * (`diff-stats.ts`), the Files panel's git status and the build pipeline's
 * worktree probes.
 *
 * The change resources are discriminated unions whose records are large and
 * still evolving (projections, diff identities, measurements). They are
 * **variant records** ({@link variantRecord}): the fields a reader routes on
 * (`kind`, ids, revisions, tokens, the file rows' identities and counts) are
 * declared and checked, and every other key passes through unchanged, so a
 * tolerant decode never strips a field the renderer reads. Their TypeScript
 * types are the protocol interfaces themselves. Plan item 7010 converges the
 * remaining fields.
 *
 * Values a newer backend may extend (`kind`, states, statuses, reason keys)
 * are `Schema.String`, not literals, so an older client still reads them.
 * Optional result fields use `Schema.optional` (handlers spread `undefined`
 * values, which the wire drops but `optionalKey` refuses in tests).
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  CanonicalToolPresentation,
  ChangeDiffFileBody,
  ChangeFileRow,
  ChangeProjection,
  ChangesApplyRestoreResult,
  ChangesGetDiffResult,
  ChangesGetFilesResult,
  ChangesGetHandoffResult,
  ChangesGetHistoryResult,
  ChangesPrepareRestoreResult,
  ChangesRefreshResult,
  ChangesResolveLiveDetailResult,
  ChangeTrackingCapabilities,
  ChangeViewResult,
} from "../../../change-resources.js";
import type { LineCount } from "../../../change-measurements.js";
import type {
  DiffBaseBranch,
  DiffBaseCommit,
  EnvironmentDiffStatsChange,
  EnvironmentDiffStatsSnapshot,
} from "../../../diff-stats.js";
import { modelRecord, openRecord, variantRecord } from "../../model-schema.js";

const optionalString = Schema.optional(Schema.String);
const optionalNullableString = Schema.optional(Schema.NullOr(Schema.String));
const optionalNumber = Schema.optional(Schema.Finite);
const NullableFinite = Schema.NullOr(Schema.Finite);

/** `ChangeError`: a coded failure the client branches on. */
export const ChangeErrorSchema = Schema.Struct({
  code: Schema.String,
  reasonKey: Schema.String,
}).annotate({ identifier: "ChangeError" });

/** `LineCount` (`change-measurements.ts`): a count with its quality, never a guessed zero. */
export const LineCountSchema = modelRecord<LineCount>()({
  value: NullableFinite,
  quality: Schema.String,
  bound: Schema.String,
}).annotate({ identifier: "LineCount" });

/** `ChangeFileRow`: one file of a projection's file page. */
export const ChangeFileRowSchema = modelRecord<ChangeFileRow>()({
  rowId: Schema.String,
  pathId: Schema.String,
  oldPathDisplay: Schema.NullOr(Schema.String),
  newPathDisplay: Schema.NullOr(Schema.String),
  status: Schema.String,
  fileKind: Schema.String,
  additions: LineCountSchema,
  deletions: LineCountSchema,
  bodyAvailability: Schema.String,
  reasonKey: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.Struct({ diffIdentityId: Schema.String })),
}).annotate({ identifier: "ChangeFileRow" });

/** `ChangeProjection`: one resource's backend-prepared presentation. */
export const ChangeProjectionSchema = modelRecord<ChangeProjection>()({
  schemaVersion: Schema.Finite,
  resourceKey: Schema.String,
  ownerGeneration: Schema.String,
  revision: Schema.Finite,
  measurementId: Schema.NullOr(Schema.String),
  state: Schema.String,
  availability: Schema.String,
  hasFileChanges: Schema.NullOr(Schema.Boolean),
  hasTextChanges: Schema.NullOr(Schema.Boolean),
  counters: Schema.Struct({
    additions: LineCountSchema,
    deletions: LineCountSchema,
    changedFiles: NullableFinite,
  }),
  reasonKeys: Schema.Array(Schema.String),
  detail: Schema.NullOr(Schema.Struct({ diffIdentityId: Schema.String })),
  filePage: Schema.NullOr(
    openRecord({
      snapshotToken: Schema.String,
      rows: Schema.Array(ChangeFileRowSchema),
      nextCursor: Schema.NullOr(Schema.String),
      totalRows: NullableFinite,
    }),
  ),
  actions: Schema.Array(
    openRecord({
      kind: Schema.String,
      targetToken: Schema.String,
      enabled: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "ChangeProjection" });

/** `changes_get_view`: a projection, `unchanged`, `reset`, `deleted` or an error. */
export const ChangeViewResultSchema = variantRecord<ChangeViewResult>()({
  kind: Schema.String,
  projection: Schema.optional(ChangeProjectionSchema),
  ownerGeneration: optionalString,
  revision: optionalNumber,
  resourceKey: optionalString,
  error: Schema.optional(ChangeErrorSchema),
}).annotate({ identifier: "ChangeViewResult" });

/** `changes_get_files`: one page of a projection's file rows, or an error. */
export const ChangesGetFilesResultSchema = variantRecord<ChangesGetFilesResult>()({
  kind: Schema.String,
  snapshotToken: optionalString,
  rows: Schema.optional(Schema.Array(ChangeFileRowSchema)),
  nextCursor: optionalNullableString,
  totalRows: Schema.optional(NullableFinite),
  deliveredRows: optionalNumber,
  omittedRows: optionalNumber,
  error: Schema.optional(ChangeErrorSchema),
}).annotate({ identifier: "ChangesGetFilesResult" });

/** `CanonicalToolPresentation`: which change resources a tool row shows. */
export const CanonicalToolPresentationSchema = modelRecord<CanonicalToolPresentation>()({
  schemaVersion: Schema.Finite,
  operationId: Schema.String,
  attemptId: Schema.String,
  revision: Schema.Finite,
  changes: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      resourceKey: Schema.String,
      prominence: Schema.String,
    }),
  ),
}).annotate({ identifier: "CanonicalToolPresentation" });

/** `changes_get_tool_presentations`: per call id, its presentation and the projections it names. */
export const ToolChangePresentationsSchema = Schema.Struct({
  presentations: Schema.Record(Schema.String, Schema.NullOr(CanonicalToolPresentationSchema)),
  projections: Schema.Record(Schema.String, ChangeProjectionSchema),
}).annotate({ identifier: "ToolChangePresentations" });

/** `changes_get_history`: a page of a session's turns, newest first, or an error. */
export const ChangesGetHistoryResultSchema = variantRecord<ChangesGetHistoryResult>()({
  kind: Schema.String,
  entries: Schema.optional(
    Schema.Array(
      openRecord({
        turnId: Schema.String,
        segmentId: Schema.String,
        turnResourceKey: Schema.String,
        measurementId: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  nextCursor: optionalNullableString,
  error: Schema.optional(ChangeErrorSchema),
}).annotate({ identifier: "ChangesGetHistoryResult" });

/** `changes_get_thread`: the session's current thread segment, or `null` before its first turn. */
export const ChangeThreadResourceSchema = Schema.NullOr(
  Schema.Struct({ segmentId: Schema.String, resourceKey: Schema.String }),
).annotate({ identifier: "ChangeThreadResource" });

/** `DiffIdentity`: what a diff body compares (`kind` comparison, file or payload). */
const DiffIdentitySchema = openRecord({
  id: Schema.String,
  kind: Schema.String,
  measurementId: Schema.String,
}).annotate({ identifier: "DiffIdentity" });

/** `changes_resolve_live_detail`: the identity a row's or path's live diff opens, or an error. */
export const ChangesResolveLiveDetailResultSchema = variantRecord<ChangesResolveLiveDetailResult>()(
  {
    kind: Schema.String,
    identity: Schema.optional(DiffIdentitySchema),
    error: Schema.optional(ChangeErrorSchema),
  },
).annotate({ identifier: "ChangesResolveLiveDetailResult" });

/** `ChangeDiffFileBody`: one file's hunks. */
export const ChangeDiffFileBodySchema = modelRecord<ChangeDiffFileBody>()({
  pathId: Schema.String,
  oldPathDisplay: Schema.NullOr(Schema.String),
  newPathDisplay: Schema.NullOr(Schema.String),
  status: Schema.String,
  fileKind: Schema.String,
  bodyAvailability: Schema.String,
  reasonKey: Schema.NullOr(Schema.String),
  hunks: Schema.Array(
    openRecord({
      header: Schema.String,
      oldStart: Schema.Finite,
      oldLines: Schema.Finite,
      newStart: Schema.Finite,
      newLines: Schema.Finite,
      lines: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          text: Schema.String,
          oldLine: NullableFinite,
          newLine: NullableFinite,
        }),
      ),
    }),
  ),
  truncated: Schema.Boolean,
}).annotate({ identifier: "ChangeDiffFileBody" });

/** `changes_get_diff`: a page of an identity's diff body, or an error naming the identity. */
export const ChangesGetDiffResultSchema = variantRecord<ChangesGetDiffResult>()({
  kind: Schema.String,
  identity: Schema.optional(DiffIdentitySchema),
  measurement: Schema.optional(Schema.NullOr(Schema.ObjectKeyword)),
  files: Schema.optional(Schema.Array(ChangeDiffFileBodySchema)),
  nextCursor: optionalNullableString,
  viewIdentityId: optionalString,
  provenanceLabelKey: optionalNullableString,
  error: Schema.optional(ChangeErrorSchema),
  identityId: optionalString,
}).annotate({ identifier: "ChangesGetDiffResult" });

/** `changes_refresh`: settled with the new projection, pending on a fence token, or an error. */
export const ChangesRefreshResultSchema = variantRecord<ChangesRefreshResult>()({
  kind: Schema.String,
  token: Schema.optional(Schema.NullOr(Schema.String)),
  requiredObservationEpoch: optionalNumber,
  projection: Schema.optional(Schema.NullOr(ChangeProjectionSchema)),
  error: Schema.optional(ChangeErrorSchema),
}).annotate({ identifier: "ChangesRefreshResult" });

/** `changes_get_handoff`: measurements as handoff text, or an error. */
export const ChangesGetHandoffResultSchema = variantRecord<ChangesGetHandoffResult>()({
  kind: Schema.String,
  text: optionalString,
  measurementIds: Schema.optional(Schema.Array(Schema.String)),
  truncated: Schema.optional(Schema.Boolean),
  error: Schema.optional(ChangeErrorSchema),
}).annotate({ identifier: "ChangesGetHandoffResult" });

/** `changes_prepare_restore`: a restore preview with its action token, disabled, or an error. */
export const ChangesPrepareRestoreResultSchema = variantRecord<ChangesPrepareRestoreResult>()({
  kind: Schema.String,
  actionToken: optionalString,
  expiresAt: optionalString,
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        pathId: Schema.String,
        pathDisplay: Schema.String,
        action: Schema.String,
        reasonKey: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  residualRiskKeys: Schema.optional(Schema.Array(Schema.String)),
  reasonKey: optionalString,
  error: Schema.optional(ChangeErrorSchema),
}).annotate({ identifier: "ChangesPrepareRestoreResult" });

/** `changes_apply_restore`: what the restore wrote, or an error. */
export const ChangesApplyRestoreResultSchema = variantRecord<ChangesApplyRestoreResult>()({
  kind: Schema.String,
  operationId: optionalString,
  outcome: optionalString,
  completedPathIds: Schema.optional(Schema.Array(Schema.String)),
  failedPathIds: Schema.optional(Schema.Array(Schema.String)),
  resultMeasurementId: optionalNullableString,
  error: Schema.optional(ChangeErrorSchema),
}).annotate({ identifier: "ChangesApplyRestoreResult" });

/** `changes_get_capabilities`: the backend's change-tracking protocol and policy. */
export const ChangeTrackingCapabilitiesSchema = modelRecord<ChangeTrackingCapabilities>()({
  capability: Schema.String,
  policyVersion: Schema.String,
  history: Schema.Boolean,
  restore: Schema.Boolean,
  gitScopes: Schema.Boolean,
  operationVolume: Schema.Boolean,
  strictCheckpoints: Schema.Boolean,
}).annotate({ identifier: "ChangeTrackingCapabilities" });

/** `changes_get_diagnostics`: content-free counters for operators. */
export const ChangeTrackingDiagnosticsSchema = openRecord({
  generation: Schema.String,
  policyVersion: Schema.String,
  pendingPulls: Schema.Finite,
  activeTurns: Schema.Finite,
  openWindows: Schema.Finite,
}).annotate({ identifier: "ChangeTrackingDiagnostics" });

/**
 * `changes_measure_legacy_payload`: the backend's measurement of a transcript
 * row recorded before canonical evidence, or `null` when there is nothing to
 * measure.
 */
export const LegacyPayloadSummarySchema = Schema.NullOr(
  openRecord({
    provenanceLabelKey: Schema.String,
    additions: LineCountSchema,
    deletions: LineCountSchema,
    changedFiles: NullableFinite,
    contentLines: NullableFinite,
    reasonKeys: Schema.mutable(Schema.Array(Schema.String)),
    files: Schema.mutable(Schema.Array(ChangeDiffFileBodySchema)),
  }),
).annotate({ identifier: "LegacyPayloadSummary" });

// --- Diff stats, diff bases, git status ---------------------------------------

const viewStamp = { generation: Schema.String, revision: Schema.Finite };

const EnvironmentDiffStatsChangeSchema = modelRecord<EnvironmentDiffStatsChange>()({
  environmentId: Schema.String,
  comparisonRef: Schema.String,
  stats: Schema.Struct({
    additions: Schema.Finite,
    deletions: Schema.Finite,
    filesChanged: Schema.Finite,
    truncated: Schema.Boolean,
  }),
  computedAt: Schema.String,
}).annotate({ identifier: "EnvironmentDiffStatsChange" });

export const EnvironmentDiffStatsSnapshotSchema = modelRecord<EnvironmentDiffStatsSnapshot>()({
  generation: optionalString,
  revision: optionalNumber,
  entries: Schema.Array(EnvironmentDiffStatsChangeSchema),
}).annotate({ identifier: "EnvironmentDiffStatsSnapshot" });

/**
 * `get_environment_diff_stats`: the whole snapshot without known revision
 * arguments, the conditional `ViewSnapshotOutcome` (`view-sync.ts`) with
 * them.
 */
export const EnvironmentDiffStatsReadSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unchanged"), ...viewStamp }),
  Schema.Struct({
    status: Schema.Literal("snapshot"),
    ...viewStamp,
    snapshot: EnvironmentDiffStatsSnapshotSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("reset"),
    ...viewStamp,
    snapshot: EnvironmentDiffStatsSnapshotSchema,
    reason: Schema.Literals(["generation", "ahead", "invalid-request"]),
  }),
  Schema.Struct({ status: Schema.Literal("deleted"), ...viewStamp }),
  EnvironmentDiffStatsSnapshotSchema,
]).annotate({ identifier: "EnvironmentDiffStatsRead" });

/** One changed file of a worktree's git status (the Files panel's Changes list). */
export const GitFileChangeSchema = Schema.Struct({
  path: Schema.String,
  originalPath: optionalString,
  filename: Schema.String,
  directory: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.String,
  // Git reported no line counts; additions and deletions are 0 for old readers.
  binary: Schema.optional(Schema.Literal(true)),
  // Listed but not counted (scan cap, unreadable, too large).
  countOmitted: Schema.optional(Schema.Literal(true)),
}).annotate({ identifier: "GitFileChange" });
export type GitFileChange = typeof GitFileChangeSchema.Type;

const GitFileChangesSchema = Schema.mutable(Schema.Array(GitFileChangeSchema));

/**
 * `get_git_status` / `get_local_git_status`: the bare list without
 * `knownDigest`, the conditional `{ unchanged, digest, value?, view? }` with
 * it (`view` is the tracked read owner's stamp, `WorktreeReadStamp`).
 */
export const GitStatusReadSchema = Schema.Union([
  GitFileChangesSchema,
  Schema.Struct({
    unchanged: Schema.Boolean,
    digest: Schema.String,
    value: Schema.optional(GitFileChangesSchema),
    view: Schema.optional(Schema.ObjectKeyword),
  }),
]).annotate({ identifier: "GitStatusRead" });

export const DiffBaseBranchSchema = modelRecord<DiffBaseBranch>()({
  ref: Schema.String,
  name: Schema.String,
  kind: Schema.String,
}).annotate({ identifier: "DiffBaseBranch" });

export const DiffBaseCommitSchema = modelRecord<DiffBaseCommit>()({
  commit: Schema.String,
  subject: Schema.String,
  author: Schema.String,
  committedAt: Schema.String,
}).annotate({ identifier: "DiffBaseCommit" });

/** `get_environment_uncommitted_paths`: HEAD, the porcelain paths and an optional content fingerprint. */
export const UncommittedPathsSchema = Schema.Struct({
  head: Schema.String,
  paths: Schema.mutable(Schema.Array(Schema.String)),
  fingerprint: optionalString,
}).annotate({ identifier: "UncommittedPaths" });

/** `get_environment_commit_ancestry`: `null` when Git cannot say. */
export const CommitAncestrySchema = Schema.Struct({
  isAncestor: Schema.NullOr(Schema.Boolean),
}).annotate({ identifier: "CommitAncestry" });
