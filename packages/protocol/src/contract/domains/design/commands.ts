/**
 * `design` commands (plan item 7004): the design canvas surface, version 1 of
 * the domain. Two generations share it:
 *
 * - the legacy v1 surface (`design_action`, `design_status`, `design_changes`,
 *   `design_import`, `design_import_host_file`, `design_save`) throws its
 *   failures, so its argument schemas are precise and a schema failure
 *   throws like today's parse did;
 * - the protocol v2 surface answers every failure, an invalid argument
 *   included, inside its typed envelope (`{ ok: false, failure: { code:
 *   "invalid-input" } }`). A schema failure in the registry would throw before
 *   the handler and break that contract, so these argument schemas declare
 *   their keys as `Unknown` and the handler decodes each field with the
 *   precise schemas below (`DesignIdSchema`, `DesignRevisionSchema`, …),
 *   in today's order, mapping a failure to `invalid-input`.
 *
 * Every argument decodes tolerantly: unknown keys are dropped, including in
 * the two objects that were `.strict()` before (`design_library.query`,
 * `design_session_link.link`). Operation descriptors and intents are
 * validated by the service (`apps/backend/src/core/design/schemas.ts`, shared
 * with the design MCP tools), so they are `Unknown` here.
 *
 * Results are the real shapes: the v2 envelope with the failure struct and
 * each command's value; model records (`modelRecord`) declare their identity,
 * revision and state fields and pass the rest through unchanged.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  DesignCanvas,
  DesignChange,
  DesignChanges,
  DesignFrame,
  DesignHierarchyPage,
  DesignHistoryStatus,
  DesignLayer,
} from "../../../design-canvas.js";
import type {
  DesignCapabilities,
  DesignCheckpointPreview,
  DesignExportAssociation,
  DesignExportPreview,
  DesignExportReceipt,
  DesignExportTarget,
  DesignFailure,
  DesignFrameIdentity,
  DesignFrameMeta,
  DesignFramePatch,
  DesignFrameValidation,
  DesignHistoryEntrySummary,
  DesignHistoryPage,
  DesignIntentDiscardResult,
  DesignIntentList,
  DesignIntentResumeResult,
  DesignIntentRunResult,
  DesignLibraryEntry,
  DesignLibraryPage,
  DesignMissing,
  DesignOperationDescriptor,
  DesignOperationResult,
  DesignOperationStatus,
  DesignPendingExport,
  DesignPreconditions,
  DesignPrepareResult,
  DesignReadiness,
  DesignRecordProblem,
  DesignRendererHealth,
  DesignSessionLink,
  DesignSessionLinkState,
  DesignSessionLinkStates,
  DesignSessionResumeResult,
  DesignSnapshotEnvelope,
  DesignStoredIntent,
  DesignSyncDelta,
  DesignSyncReset,
  DesignSyncStatus,
  DesignSyncUnchanged,
  DesignTombstone,
  DesignWorkspaceMeta,
} from "../../../design-operations.js";
import { DESIGN_MAX_DOCUMENT_BYTES } from "../../../design-canvas.js";
import { defineCommand } from "../../command.js";
import { modelRecord, opaqueRecord } from "../../model-schema.js";
import { designDomain } from "./domain.js";

// ---------------------------------------------------------------------------
// Precise argument fields (today's per-field parses, as Effect Schema)
// ---------------------------------------------------------------------------

const boundedString = (min: number, max: number) =>
  Schema.String.check(Schema.isBetweenLength(min, max));
const maxString = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const intBetween = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

/** An environment id as the design commands take it. */
export const DesignEnvironmentIdSchema = boundedString(1, 256);
/** A canvas or frame id (a UUID). */
export const DesignIdSchema = Schema.String.check(Schema.isUUID());
/** A canvas, frame or cursor revision. */
export const DesignRevisionSchema = intBetween(0, Number.MAX_SAFE_INTEGER - 1);
/** A prepared operation's token as the commands accept it. */
export const DesignTokenSchema = boundedString(1, 100);
/** A service generation a client quotes back. */
export const DesignGenerationSchema = maxString(100);
export const DesignStatusVersionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const DesignWaitMsSchema = intBetween(0, 60_000);
export const DesignOffsetSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const DesignHistoryLimitSchema = intBetween(1, 100);
export const DesignEntryIdSchema = boundedString(1, 64);
export const DesignCheckpointSideSchema = Schema.Literals(["before", "after"]);
/** A repository-relative path (the export writer validates its form). */
export const DesignRelativePathSchema = maxString(240);
export const DesignFingerprintSchema = maxString(80);
export const DesignRootSelectorSchema = maxString(2048);
export const DesignCursorSchema = maxString(200);
export const DesignMaxNodesSchema = intBetween(1, 200);
export const DesignMaxDepthSchema = intBetween(1, 32);
export const DesignCapturePrioritySchema = Schema.Literals(["interactive", "background"]);
export const DesignLinkIdSchema = boundedString(1, 40);
export const DesignReplaceLinkIdSchema = maxString(40);
export const DesignTabIdSchema = boundedString(1, 200);

/** `design_library`'s query; unknown keys are dropped (it was `.strict()`). */
export const DesignLibraryQuerySchema = Schema.Struct({
  search: Schema.optionalKey(maxString(120)),
  filter: Schema.optionalKey(Schema.Literals(["live", "deleted", "all"])),
  sort: Schema.optionalKey(Schema.Literals(["modified", "name"])),
  offset: Schema.optionalKey(DesignOffsetSchema),
  limit: Schema.optionalKey(intBetween(1, 50)),
});

/** `design_session_link`'s link; unknown keys are dropped (it was `.strict()`). */
export const DesignSessionLinkInputSchema = Schema.Struct({
  tabId: DesignTabIdSchema,
  sessionId: Schema.optionalKey(boundedString(1, 200)),
  platform: boundedString(1, 40),
  role: Schema.Literals(["design", "implementation"]),
  checkpointId: Schema.optionalKey(maxString(64)),
  label: Schema.optionalKey(maxString(120)),
});

const utf8 = new TextEncoder();

/** A serialized `.orkdes` document within the document byte limit. */
export const DesignDocumentTextSchema = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      value.length <= DESIGN_MAX_DOCUMENT_BYTES ||
      utf8.encode(value).length <= DESIGN_MAX_DOCUMENT_BYTES,
    { message: "Design document exceeds 4 MiB" },
  ),
);

// ---------------------------------------------------------------------------
// Result records
// ---------------------------------------------------------------------------

const Str = Schema.String;
const Num = Schema.Finite;
const Bool = Schema.Boolean;
const opt = Schema.optional;

export const DesignFailureSchema = modelRecord<DesignFailure>()({
  code: Schema.Literals([
    "conflict",
    "invalid-input",
    "invalid-content",
    "renderer-unavailable",
    "capacity",
    "deadline",
    "disconnected",
    "deleted",
    "not-found",
    "forbidden",
    "expired-operation",
    "unknown-outcome",
    "unsupported",
    "storage",
    "export-collision",
    "history-ineligible",
  ]),
  message: Str,
  retry: Schema.Literals(["never", "after-refresh", "after-delay", "safe", "review"]),
  retryAfterMs: opt(Num),
});

/** The v2 envelope: a value, or a typed failure (never thrown). */
function designResult<V extends Schema.Top>(value: V) {
  return Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value }),
    Schema.Struct({ ok: Schema.Literal(false), failure: DesignFailureSchema }),
  ]);
}

export const DesignFrameSchema = modelRecord<DesignFrame>()({
  id: Str,
  name: Str,
  x: Num,
  y: Num,
  width: Num,
  height: Num,
  html: Str,
  revision: Num,
});

export const DesignCanvasSchema = modelRecord<DesignCanvas>()({
  format: Schema.Literal("orkdes"),
  version: Schema.Literal(1),
  id: Str,
  environmentId: Str,
  name: Str,
  revision: Num,
  frames: Schema.Array(DesignFrameSchema),
});

export const DesignCapabilitiesSchema = modelRecord<DesignCapabilities>()({
  protocolVersion: Num,
  responseVersion: Num,
  snapshot: Bool,
  operations: Bool,
  sync: Bool,
  save: Bool,
  history: Bool,
  lifecycle: Bool,
  rendererHealth: Bool,
  library: Bool,
  batch: Bool,
  sessions: Bool,
  validation: Bool,
  hierarchyPaging: Bool,
  intents: opt(Bool),
});

export const DesignRendererHealthSchema = modelRecord<DesignRendererHealth>()({
  state: Schema.Literals([
    "unknown",
    "missing-executable",
    "launch-failed",
    "saturated",
    "ready",
    "running",
    "recovering",
    "stopping",
  ]),
  ready: Bool,
  message: Str,
  checkedAt: opt(Str),
  queued: Num,
  running: Num,
  generation: Num,
  executableConfigured: Bool,
  error: opt(Str),
});

export const DesignReadinessSchema = modelRecord<DesignReadiness>()({
  capabilities: DesignCapabilitiesSchema,
  storage: modelRecord<DesignReadiness["storage"]>()({
    available: Bool,
    canvases: Num,
    limit: Num,
    message: opt(Str),
  }),
  renderer: DesignRendererHealthSchema,
});

const DesignValidationStateSchema = Schema.Literals([
  "unvalidated",
  "validating",
  "valid",
  "invalid",
  "renderer-unavailable",
]);

export const DesignFrameValidationSchema = modelRecord<DesignFrameValidation>()({
  frameId: Str,
  contentId: Str,
  runtimeVersion: Num,
  state: DesignValidationStateSchema,
  reasons: Schema.Array(
    modelRecord<DesignFrameValidation["reasons"][number]>()({ code: Str, count: opt(Num) }),
  ),
  truncated: Bool,
  elementCount: opt(Num),
  validatedAt: opt(Str),
  message: opt(Str),
});

const DesignFrameIdentitySchema = modelRecord<DesignFrameIdentity>()({
  contentId: Str,
  structureId: Str,
  viewportId: Str,
});

const DesignFrameMetaSchema = modelRecord<DesignFrameMeta>()({
  contentId: Str,
  structureId: Str,
  viewportId: Str,
  validation: DesignFrameValidationSchema,
  modifiedAt: Str,
});

const DesignHistoryStatusSchema = modelRecord<DesignHistoryStatus>()({
  revision: Num,
  undoCount: Num,
  redoCount: Num,
  canUndo: Bool,
  canRedo: Bool,
});

export const DesignSessionLinkSchema = modelRecord<DesignSessionLink>()({
  id: Str,
  tabId: Str,
  sessionId: opt(Str),
  platform: Str,
  role: Schema.Literals(["design", "implementation"]),
  createdAt: Str,
  checkpointId: opt(Str),
  label: opt(Str),
});

const DesignExportAssociationSchema = modelRecord<DesignExportAssociation>()({
  relativePath: Str,
  repository: Str,
  lastExportedRevision: Num,
  digest: Str,
  exportedAt: Str,
});

const DesignPendingExportSchema = modelRecord<DesignPendingExport>()({
  token: Str,
  relativePath: Str,
  repository: Str,
  revision: Num,
  digest: Str,
  startedAt: Str,
  state: Schema.Literals(["writing", "unknown", "failed"]),
});

const workspaceFields = {
  recordSequence: Num,
  statusVersion: Num,
  incarnation: Str,
  createdAt: Str,
  modifiedAt: Str,
  history: DesignHistoryStatusSchema,
  export: opt(DesignExportAssociationSchema),
  pendingExport: opt(DesignPendingExportSchema),
  sessions: Schema.Array(DesignSessionLinkSchema),
  migratedFromLegacy: opt(Bool),
};

export const DesignWorkspaceMetaSchema = modelRecord<DesignWorkspaceMeta>()({
  ...workspaceFields,
  frames: Schema.Record(Str, DesignFrameMetaSchema),
});

export const DesignSnapshotEnvelopeSchema = modelRecord<DesignSnapshotEnvelope>()({
  kind: Schema.Literal("snapshot"),
  responseVersion: Num,
  generation: Str,
  canvas: DesignCanvasSchema,
  workspace: DesignWorkspaceMetaSchema,
});

export const DesignTombstoneSchema = modelRecord<DesignTombstone>()({
  kind: Schema.Literal("deleted"),
  responseVersion: Num,
  generation: Str,
  canvasId: Str,
  name: Str,
  revision: Num,
  deletedAt: Str,
  restorable: Bool,
  statusVersion: Num,
});

export const DesignMissingSchema = modelRecord<DesignMissing>()({
  kind: Schema.Literal("missing"),
  responseVersion: Num,
  generation: Str,
  canvasId: Str,
});

export const DesignRecordProblemSchema = modelRecord<DesignRecordProblem>()({
  kind: Schema.Literal("record-problem"),
  responseVersion: Num,
  generation: Str,
  canvasId: Str,
  problem: Schema.Literals(["corrupt", "unsupported-version"]),
  message: Str,
  backupAvailable: Bool,
});

export const DesignSnapshotResultSchema = Schema.Union([
  DesignSnapshotEnvelopeSchema,
  DesignTombstoneSchema,
  DesignMissingSchema,
  DesignRecordProblemSchema,
]);

const DesignFramePatchSchema = modelRecord<DesignFramePatch>()({
  id: Str,
  revision: Num,
  identity: DesignFrameIdentitySchema,
});

export const DesignSyncResultSchema = Schema.Union([
  modelRecord<DesignSyncUnchanged>()({
    kind: Schema.Literal("unchanged"),
    responseVersion: Num,
    generation: Str,
    revision: Num,
    statusVersion: Num,
  }),
  modelRecord<DesignSyncDelta>()({
    kind: Schema.Literal("delta"),
    responseVersion: Num,
    generation: Str,
    baseRevision: Num,
    revision: Num,
    statusVersion: Num,
    added: Schema.Array(DesignFramePatchSchema),
    patched: Schema.Array(DesignFramePatchSchema),
    removed: Schema.Array(Str),
    workspace: modelRecord<DesignSyncDelta["workspace"]>()(workspaceFields),
    frameMeta: opt(Schema.Record(Str, DesignFrameMetaSchema)),
  }),
  modelRecord<DesignSyncStatus>()({
    kind: Schema.Literal("status"),
    responseVersion: Num,
    generation: Str,
    revision: Num,
    statusVersion: Num,
    workspace: DesignWorkspaceMetaSchema,
  }),
  modelRecord<DesignSyncReset>()({
    kind: Schema.Literal("reset"),
    responseVersion: Num,
    generation: Str,
    revision: Num,
    reason: Schema.Literals([
      "generation",
      "future-cursor",
      "expired-range",
      "too-large",
      "unsupported",
      "restored",
    ]),
  }),
  DesignSnapshotEnvelopeSchema,
  DesignTombstoneSchema,
  DesignMissingSchema,
  DesignRecordProblemSchema,
]);

const DesignOperationStateSchema = Schema.Literals([
  "prepared",
  "executing",
  "committed",
  "no-op",
  "rejected",
  "canceled",
  "interrupted",
  "expired",
  "unknown",
]);

const DesignActorSchema = Schema.Literals(["user", "agent", "system"]);

export const DesignOperationResultSchema = modelRecord<DesignOperationResult>()({
  canvasRevision: Num,
  frames: Schema.Array(
    modelRecord<DesignOperationResult["frames"][number]>()({
      frameId: Str,
      revision: Num,
      removed: opt(Bool),
    }),
  ),
  createdFrameId: opt(Str),
  createdCanvasId: opt(Str),
  historyEntryId: opt(Str),
});

export const DesignOperationStatusSchema = modelRecord<DesignOperationStatus>()({
  token: Str,
  canvasId: Str,
  kind: Str,
  state: DesignOperationStateSchema,
  actor: DesignActorSchema,
  base: opaqueRecord<DesignPreconditions>(),
  result: opt(DesignOperationResultSchema),
  failure: opt(DesignFailureSchema),
  gestureId: opt(Str),
  correlationId: opt(Str),
  clientId: opt(Str),
  preparedAt: Str,
  updatedAt: Str,
  expiresAt: opt(Str),
});

export const DesignPrepareResultSchema = modelRecord<DesignPrepareResult>()({
  token: Str,
  canvasId: Str,
  state: Schema.Literal("prepared"),
  expiresAt: Str,
});

export const DesignStoredIntentSchema = modelRecord<DesignStoredIntent>()({
  id: Str,
  clientId: Str,
  lane: Str,
  label: Str,
  createdAt: Num,
  updatedAt: Num,
  descriptor: opaqueRecord<DesignOperationDescriptor>(),
  phase: Schema.Literals(["draft", "preparing", "admitted", "settled"]),
  token: opt(Str),
  outcome: opt(DesignOperationStateSchema),
  failure: opt(DesignFailureSchema),
  result: opt(DesignOperationResultSchema),
  gestureKey: opt(Str),
});

export const DesignIntentListSchema = modelRecord<DesignIntentList>()({
  intents: Schema.Array(DesignStoredIntentSchema),
  sending: Schema.Array(Str),
  now: Num,
});

export const DesignIntentRunResultSchema = modelRecord<DesignIntentRunResult>()({
  intent: opt(DesignStoredIntentSchema),
  status: opt(DesignOperationStatusSchema),
  failure: opt(DesignFailureSchema),
});

const DesignLibraryEntrySchema = modelRecord<DesignLibraryEntry>()({
  id: Str,
  name: Str,
  revision: Num,
  modifiedAt: Str,
  createdAt: Str,
  frameCount: Num,
  state: Schema.Literals(["live", "deleted", "problem"]),
  deletedAt: opt(Str),
  validation: modelRecord<DesignLibraryEntry["validation"]>()({ invalid: Num, unvalidated: Num }),
});

export const DesignLibraryPageSchema = modelRecord<DesignLibraryPage>()({
  entries: Schema.Array(DesignLibraryEntrySchema),
  total: Num,
  nextOffset: opt(Num),
  quota: modelRecord<DesignLibraryPage["quota"]>()({
    live: Num,
    liveLimit: Num,
    deleted: Num,
    deletedLimit: Num,
    deletedBytes: Num,
    deletedBytesLimit: Num,
  }),
});

const DesignHistoryEntrySchema = modelRecord<DesignHistoryEntrySummary>()({
  id: Str,
  kind: Str,
  label: Str,
  actor: DesignActorSchema,
  createdAt: Str,
  canvasRevisionBefore: Num,
  canvasRevisionAfter: Num,
  frames: Schema.Array(
    modelRecord<DesignHistoryEntrySummary["frames"][number]>()({ frameId: Str, name: Str }),
  ),
  undone: Bool,
  protected: Bool,
  bytes: Num,
});

export const DesignHistoryPageSchema = modelRecord<DesignHistoryPage>()({
  entries: Schema.Array(DesignHistoryEntrySchema),
  total: Num,
  nextOffset: opt(Num),
  bytes: Num,
  limits: Schema.Struct({ entries: Num, bytes: Num }),
});

export const DesignCheckpointPreviewSchema = modelRecord<DesignCheckpointPreview>()({
  entryId: Str,
  side: DesignCheckpointSideSchema,
  frames: Schema.Array(
    modelRecord<DesignCheckpointPreview["frames"][number]>()({
      frameId: Str,
      frame: Schema.NullOr(DesignFrameSchema),
    }),
  ),
  canvasName: opt(Str),
});

const DesignExportTargetSchema = modelRecord<DesignExportTarget>()({
  relativePath: Str,
  exists: Bool,
  canvasId: opt(Str),
  sameCanvas: Bool,
  fingerprint: opt(Str),
  readable: Bool,
  needsReplaceConfirmation: Bool,
});

export const DesignExportPreviewSchema = modelRecord<DesignExportPreview>()({
  suggestedPath: Str,
  association: opt(DesignExportAssociationSchema),
  target: DesignExportTargetSchema,
  revision: Num,
});

export const DesignExportReceiptSchema = modelRecord<DesignExportReceipt>()({
  token: Str,
  relativePath: Str,
  revision: Num,
  digest: Str,
  replaced: Bool,
  exportedAt: Str,
  currentRevision: Num,
});

/** `design_hierarchy`'s value. */
export interface DesignHierarchyResult {
  revision: number;
  structureId: string;
  page: DesignHierarchyPage;
}

export const DesignHierarchyResultSchema = modelRecord<DesignHierarchyResult>()({
  revision: Num,
  structureId: Str,
  page: modelRecord<DesignHierarchyPage>()({
    layers: Schema.Array(
      modelRecord<DesignLayer>()({ selector: Str, tag: Str, label: Str, depth: Num }),
    ),
    nextCursor: opt(Str),
    total: Num,
    truncated: Bool,
    bytes: Num,
  }),
});

/** `design_capture`'s value: a PNG of the exact revision it depicts. */
export interface DesignCaptureResult {
  revision: number;
  contentId: string;
  viewportId: string;
  data: string;
  mimeType: string;
}

export const DesignCaptureResultSchema = modelRecord<DesignCaptureResult>()({
  revision: Num,
  contentId: Str,
  viewportId: Str,
  data: Str,
  mimeType: Str,
});

export const DesignSessionLinkStatesSchema = modelRecord<DesignSessionLinkStates>()({
  sessions: Schema.Array(DesignSessionLinkSchema),
  states: Schema.Array(
    modelRecord<DesignSessionLinkState>()({
      linkId: Str,
      session: Schema.Literals(["retained", "missing"]),
    }),
  ),
});

export const DesignSessionResumeResultSchema = modelRecord<DesignSessionResumeResult>()({
  link: DesignSessionLinkSchema,
  providerSessionId: Str,
});

export const DesignChangesSchema = modelRecord<DesignChanges>()({
  generation: Str,
  revision: Num,
  reset: Bool,
  events: Schema.Array(
    modelRecord<DesignChange>()({
      canvasId: Str,
      revision: Num,
      frameId: opt(Str),
      statusVersion: opt(Num),
    }),
  ),
});

/** `design_status` without a design service: the legacy "not ready" answer. */
const DesignStatusUnavailableSchema = Schema.Struct({
  ready: Schema.Literal(false),
  error: Str,
});

/**
 * `design_action` dispatches to one of the design tools (`design/tools.ts`),
 * each with its own record (a canvas, a frame, a list, a receipt…): any JSON
 * object or array.
 */
export const DesignActionResultSchema = Schema.Union([
  Schema.Record(Str, Schema.Unknown),
  Schema.Array(Schema.Unknown),
]);

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** A v2 argument: declared, decoded by the handler inside the envelope. */
const field = Schema.optionalKey(Schema.Unknown);

function v2Args<const K extends string>(...keys: K[]) {
  return Schema.Struct(
    Object.fromEntries(keys.map((key) => [key, field])) as { readonly [P in K]: typeof field },
  );
}

const common = { domain: designDomain, since: 1, access: "workspace", read: false } as const;

// Legacy v1 surface: thrown failures, legacy shapes. The UI acts as the user.

export const designActionCommand = defineCommand({
  ...common,
  name: "design_action",
  args: Schema.Struct({
    environmentId: DesignEnvironmentIdSchema,
    action: Str,
    input: Schema.optionalKey(Schema.Unknown),
  }),
  result: DesignActionResultSchema,
  critical: [],
});

export const designStatusCommand = defineCommand({
  ...common,
  name: "design_status",
  args: Schema.Struct({}),
  result: Schema.Union([DesignRendererHealthSchema, DesignStatusUnavailableSchema]),
  critical: [],
});

export const designChangesCommand = defineCommand({
  ...common,
  name: "design_changes",
  args: Schema.Struct({
    canvasId: DesignIdSchema,
    environmentId: DesignEnvironmentIdSchema,
    generation: Schema.optionalKey(DesignGenerationSchema),
    after: DesignRevisionSchema,
  }),
  result: DesignChangesSchema,
  critical: [],
});

export const designImportCommand = defineCommand({
  ...common,
  name: "design_import",
  args: Schema.Struct({
    environmentId: DesignEnvironmentIdSchema,
    document: DesignDocumentTextSchema,
  }),
  result: DesignCanvasSchema,
  critical: [],
});

export const designImportHostFileCommand = defineCommand({
  ...common,
  name: "design_import_host_file",
  args: Schema.Struct({
    environmentId: DesignEnvironmentIdSchema,
    path: boundedString(1, 4096),
  }),
  result: DesignCanvasSchema,
  critical: [],
});

export const designSaveCommand = defineCommand({
  ...common,
  name: "design_save",
  args: Schema.Struct({
    environmentId: DesignEnvironmentIdSchema,
    canvasId: DesignIdSchema,
    filePath: DesignRelativePathSchema,
    expectedRevision: DesignRevisionSchema,
  }),
  result: Schema.Struct({ filePath: Str, revision: Num }),
  critical: [],
});

// Protocol v2 surface: typed envelopes.

export const designCapabilitiesCommand = defineCommand({
  ...common,
  name: "design_capabilities",
  args: Schema.Struct({}),
  result: designResult(DesignCapabilitiesSchema),
  critical: [],
});

export const designReadinessCommand = defineCommand({
  ...common,
  name: "design_readiness",
  args: v2Args("probe"),
  result: designResult(DesignReadinessSchema),
  critical: [],
});

export const designSnapshotCommand = defineCommand({
  ...common,
  name: "design_snapshot",
  args: v2Args("environmentId", "canvasId"),
  result: designResult(DesignSnapshotResultSchema),
  critical: [],
});

export const designSyncCommand = defineCommand({
  ...common,
  name: "design_sync",
  args: v2Args("environmentId", "canvasId", "generation", "after", "statusVersion"),
  result: designResult(DesignSyncResultSchema),
  critical: [],
});

export const designPrepareCommand = defineCommand({
  ...common,
  name: "design_prepare",
  args: v2Args("environmentId", "descriptor"),
  result: designResult(DesignPrepareResultSchema),
  critical: [],
});

export const designExecuteCommand = defineCommand({
  ...common,
  name: "design_execute",
  args: v2Args("environmentId", "canvasId", "token", "waitMs"),
  result: designResult(DesignOperationStatusSchema),
  critical: [],
});

export const designOperationStatusCommand = defineCommand({
  ...common,
  name: "design_operation_status",
  args: v2Args("environmentId", "canvasId", "token"),
  result: designResult(DesignOperationStatusSchema),
  critical: [],
});

export const designCancelCommand = defineCommand({
  ...common,
  name: "design_cancel",
  args: v2Args("environmentId", "canvasId", "token"),
  result: designResult(DesignOperationStatusSchema),
  critical: [],
});

export const designIntentsCommand = defineCommand({
  ...common,
  name: "design_intents",
  args: v2Args("environmentId", "canvasId"),
  result: designResult(DesignIntentListSchema),
  critical: [],
});

export const designIntentSaveCommand = defineCommand({
  ...common,
  name: "design_intent_save",
  args: v2Args("environmentId", "canvasId", "clientId", "drafts"),
  result: designResult(Schema.Struct({ saved: Schema.Array(Str) })),
  critical: [],
});

export const designIntentImportCommand = defineCommand({
  ...common,
  name: "design_intent_import",
  args: v2Args("environmentId", "canvasId", "clientId", "intents"),
  result: designResult(
    Schema.Struct({ imported: Num, skipped: Num, retained: opt(Schema.Array(Num)) }),
  ),
  critical: [],
});

export const designIntentRunCommand = defineCommand({
  ...common,
  name: "design_intent_run",
  args: v2Args("environmentId", "canvasId", "intent", "waitMs"),
  result: designResult(DesignIntentRunResultSchema),
  critical: [],
});

export const designIntentResumeCommand = defineCommand({
  ...common,
  name: "design_intent_resume",
  args: v2Args("environmentId", "canvasId", "intentId", "clientId", "rebaseTo"),
  result: designResult(
    modelRecord<DesignIntentResumeResult>()({ intent: opt(DesignStoredIntentSchema) }),
  ),
  critical: [],
});

export const designIntentDiscardCommand = defineCommand({
  ...common,
  name: "design_intent_discard",
  args: v2Args("environmentId", "canvasId", "intentId"),
  result: designResult(
    modelRecord<DesignIntentDiscardResult>()({ discarded: Bool, mayStillFinish: Bool }),
  ),
  critical: [],
});

export const designLibraryCommand = defineCommand({
  ...common,
  name: "design_library",
  args: v2Args("environmentId", "query"),
  result: designResult(DesignLibraryPageSchema),
  critical: [],
});

export const designPurgeCommand = defineCommand({
  ...common,
  name: "design_purge",
  args: v2Args("environmentId", "canvasId"),
  result: designResult(Schema.Struct({ purged: Schema.Literal(true) })),
  critical: [],
});

export const designHistoryCommand = defineCommand({
  ...common,
  name: "design_history",
  args: v2Args("environmentId", "canvasId", "offset", "limit"),
  result: designResult(DesignHistoryPageSchema),
  critical: [],
});

export const designCheckpointCommand = defineCommand({
  ...common,
  name: "design_checkpoint",
  args: v2Args("environmentId", "canvasId", "entryId", "side"),
  result: designResult(DesignCheckpointPreviewSchema),
  critical: [],
});

export const designExportPreviewCommand = defineCommand({
  ...common,
  name: "design_export_preview",
  args: v2Args("environmentId", "canvasId", "relativePath"),
  result: designResult(DesignExportPreviewSchema),
  critical: [],
});

export const designExportSaveCommand = defineCommand({
  ...common,
  name: "design_export_save",
  args: v2Args("environmentId", "canvasId", "relativePath", "revision", "replaceFingerprint"),
  result: designResult(DesignExportReceiptSchema),
  // `replaceFingerprint` is not critical: a receiver ignoring it saves as
  // "absent" and refuses to replace the file (`export-collision`), which is safe.
  critical: [],
});

export const designOpenFileCommand = defineCommand({
  ...common,
  name: "design_open_file",
  args: v2Args("environmentId", "relativePath"),
  result: designResult(Schema.Struct({ canvasId: Str, imported: Bool })),
  critical: [],
});

export const designExportReconcileCommand = defineCommand({
  ...common,
  name: "design_export_reconcile",
  args: v2Args("environmentId", "canvasId"),
  result: designResult(
    Schema.Struct({
      state: Schema.Literals(["exported", "not-exported", "unavailable", "none"]),
      receipt: opt(DesignExportReceiptSchema),
    }),
  ),
  critical: [],
});

export const designValidateCommand = defineCommand({
  ...common,
  name: "design_validate",
  args: v2Args("environmentId", "canvasId", "frameId"),
  result: designResult(Schema.NullOr(DesignFrameValidationSchema)),
  critical: [],
});

export const designHierarchyCommand = defineCommand({
  ...common,
  name: "design_hierarchy",
  args: v2Args(
    "environmentId",
    "canvasId",
    "frameId",
    "rootSelector",
    "cursor",
    "maxNodes",
    "maxDepth",
  ),
  result: designResult(DesignHierarchyResultSchema),
  critical: [],
});

export const designCaptureCommand = defineCommand({
  ...common,
  name: "design_capture",
  args: v2Args("environmentId", "canvasId", "frameId", "priority"),
  result: designResult(DesignCaptureResultSchema),
  critical: [],
});

export const designSessionLinkCommand = defineCommand({
  ...common,
  name: "design_session_link",
  args: v2Args("environmentId", "canvasId", "link", "replaceId"),
  result: designResult(DesignSessionLinkSchema),
  critical: [],
});

export const designSessionLinkStatesCommand = defineCommand({
  ...common,
  name: "design_session_link_states",
  args: v2Args("environmentId", "canvasId"),
  result: designResult(DesignSessionLinkStatesSchema),
  critical: [],
});

export const designSessionResumeCommand = defineCommand({
  ...common,
  name: "design_session_resume",
  args: v2Args("environmentId", "canvasId", "linkId", "expectedTabId", "tabId"),
  result: designResult(DesignSessionResumeResultSchema),
  // expectedTabId: the compare-and-set on the link's tab; a receiver ignoring
  // it would let two windows adopt one conversation.
  critical: ["expectedTabId"],
});

export const designSessionUnlinkCommand = defineCommand({
  ...common,
  name: "design_session_unlink",
  args: v2Args("environmentId", "canvasId", "linkId"),
  result: designResult(Schema.Struct({ unlinked: Schema.Literal(true) })),
  critical: [],
});

/** The legacy v1 commands (thrown failures). */
export const DESIGN_LEGACY_COMMANDS = [
  designActionCommand,
  designStatusCommand,
  designChangesCommand,
  designImportCommand,
  designImportHostFileCommand,
  designSaveCommand,
] as const;

/** The protocol v2 commands (typed envelopes). */
export const DESIGN_V2_COMMANDS = [
  designCapabilitiesCommand,
  designReadinessCommand,
  designSnapshotCommand,
  designSyncCommand,
  designPrepareCommand,
  designExecuteCommand,
  designOperationStatusCommand,
  designCancelCommand,
  designIntentsCommand,
  designIntentSaveCommand,
  designIntentImportCommand,
  designIntentRunCommand,
  designIntentResumeCommand,
  designIntentDiscardCommand,
  designLibraryCommand,
  designPurgeCommand,
  designHistoryCommand,
  designCheckpointCommand,
  designExportPreviewCommand,
  designExportSaveCommand,
  designOpenFileCommand,
  designExportReconcileCommand,
  designValidateCommand,
  designHierarchyCommand,
  designCaptureCommand,
  designSessionLinkCommand,
  designSessionLinkStatesCommand,
  designSessionResumeCommand,
  designSessionUnlinkCommand,
] as const;

/** Every `design` command. */
export const DESIGN_COMMANDS = [...DESIGN_LEGACY_COMMANDS, ...DESIGN_V2_COMMANDS] as const;
