/**
 * `web-annotations` commands (plan item 7004): the authenticated, bounded
 * surface of the backend web annotation service (names in
 * `WEB_ANNOTATION_COMMANDS`, shapes in `WebAnnotationCommandArgs` /
 * `WebAnnotationCommandResults`).
 *
 * The argument schemas are the former Zod schema map of
 * `commands-registry-web-annotations.ts`, converted to Effect Schema with the
 * same bounds. Every one was `.strict()`; they decode tolerantly now (unknown
 * keys are dropped, §11.4), except that the commands whose handler refused a
 * declared `provenance` keep refusing it (`provenance` is declared and never
 * accepted, so the receiver-assigned provenance cannot be claimed by a
 * client). Captures and destinations keep their protocol validators
 * (`validateWebAnnotationCaptureInput`, `isWebAnnotationDestination`) as
 * checks.
 *
 * Results are the protocol's model interfaces through `modelRecord`: the
 * fields callers branch on are declared and validated, every other key passes
 * through unchanged, and the TypeScript type is the interface itself.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { AGENT_PLATFORMS } from "../../../agent-platforms.js";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_ROLLOUT_MODES,
  type WebAnnotation,
  type WebAnnotationAsset,
  type WebAnnotationCapture,
  type WebAnnotationCommandResults,
  type WebAnnotationDestination,
  type WebAnnotationDestinationOption,
  type WebAnnotationDraft,
  type WebAnnotationEntry,
  type WebAnnotationOperationReceipt,
  type WebAnnotationRequest,
  type WebAnnotationResponseExcerpt,
  type WebAnnotationResult,
  type WebAnnotationSummary,
} from "../../../web-annotations.js";
import {
  assertNoDeclaredProvenance,
  isWebAnnotationDestination,
  validateWebAnnotationCaptureInput,
} from "../../../web-annotations-validation.js";
import { defineCommand } from "../../command.js";
import { modelRecord, opaqueRecord } from "../../model-schema.js";
import { webAnnotationsDomain } from "./domain.js";

type Results = WebAnnotationCommandResults;

// ---------------------------------------------------------------------------
// Argument building blocks (the former Zod schema map's).

const ID_MESSAGE = { message: "must be a bounded opaque id" };

/** `isWebAnnotationId`: non-empty, bounded, `[A-Za-z0-9][A-Za-z0-9._:-]*`. */
const Id = Schema.String.check(
  Schema.isMinLength(1, ID_MESSAGE),
  Schema.isMaxLength(WEB_ANNOTATION_LIMITS.idChars, ID_MESSAGE),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, ID_MESSAGE),
);

const Revision = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER - 1),
);

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

const Body = text(WEB_ANNOTATION_LIMITS.entryChars * 2);
const Title = text(WEB_ANNOTATION_LIMITS.titleChars * 2);
const EditorId = text(400);
const Operation = Schema.Literals(["discuss", "implement"]);

/** A destination tab (`isWebAnnotationDestination`), as a struct plus the validator. */
const Destination = Schema.Struct({
  agent: Schema.Literals(AGENT_PLATFORMS),
  tabId: Id,
  logicalSessionKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  label: Schema.optionalKey(text(WEB_ANNOTATION_LIMITS.titleChars)),
}).check(Schema.makeFilter(isWebAnnotationDestination, { message: "destination is invalid" }));

/**
 * A capture input: refused when it declares a provenance or fails the
 * protocol validator, with the validator's own message.
 */
const Capture = Schema.Unknown.check(
  Schema.makeFilter((value: unknown) => {
    try {
      assertNoDeclaredProvenance(value);
    } catch (error) {
      return error instanceof Error ? error.message : "invalid";
    }
    const result = validateWebAnnotationCaptureInput(value);
    return result.ok ? true : result.error;
  }),
);

/**
 * Declared so it is never accepted: provenance is assigned by the receiving
 * boundary, and a payload that claims one is refused rather than trusted.
 */
const NoProvenance = Schema.optionalKey(
  Schema.Never.annotate({ message: "Provenance is assigned by the receiver" }),
);

const EntryLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(WEB_ANNOTATION_LIMITS.entryPageItems),
);

/** The base64 PNG ceiling of `web_annotation_asset_stage` (`maxBase64Chars`). */
export const WEB_ANNOTATION_MAX_ASSET_BASE64_CHARS =
  Math.ceil(WEB_ANNOTATION_LIMITS.imageBytes / 3) * 4;

const optional = Schema.optionalKey;

// ---------------------------------------------------------------------------
// Result records.

const Str = Schema.String;
const Num = Schema.Finite;
const Strings = Schema.Array(Schema.String);
const NullableString = Schema.NullOr(Schema.String);

const DestinationRecord = modelRecord<WebAnnotationDestination>()({
  agent: Str,
  tabId: Str,
  logicalSessionKey: Str,
});

const annotationFields = {
  id: Str,
  environmentId: Str,
  metadataRevision: Num,
  contentRevision: Num,
  captureRevision: Num,
  currentCaptureId: Str,
  title: Str,
  state: Str,
  hidden: Schema.Boolean,
  activeRequestId: NullableString,
  requestIds: Strings,
  entryCount: Num,
  lastSequence: Num,
} as const;

const AnnotationRecord = modelRecord<WebAnnotation>()(annotationFields);
const SummaryRecord = modelRecord<WebAnnotationSummary>()(annotationFields);

const CaptureRecord = modelRecord<WebAnnotationCapture>()({
  id: Str,
  annotationId: Str,
  revision: Num,
  producer: Str,
  state: Str,
  assetIds: Strings,
});

const EntryRecord = modelRecord<WebAnnotationEntry>()({
  id: Str,
  annotationId: Str,
  sequence: Num,
  kind: Str,
  body: NullableString,
  contentRevision: Num,
  captureId: NullableString,
});

const DraftRecord = modelRecord<WebAnnotationDraft>()({
  id: Str,
  environmentId: Str,
  editorId: Str,
  revision: Num,
  text: Str,
  annotationId: NullableString,
  updatedAt: Str,
});

const RequestRecord = modelRecord<WebAnnotationRequest>()({
  id: Str,
  environmentId: Str,
  revision: Num,
  operation: Str,
  state: Str,
  destination: DestinationRecord,
  bodyHash: Str,
  resultIds: Strings,
  createdAt: Str,
  updatedAt: Str,
});

const ResultRecord = modelRecord<WebAnnotationResult>()({
  id: Str,
  requestId: Str,
  revision: Num,
  provisional: Schema.Boolean,
  summary: Str,
  captureIds: Strings,
});

const ReceiptRecord = modelRecord<WebAnnotationOperationReceipt>()({
  operationId: Str,
  annotationId: Str,
  captureId: NullableString,
  entryId: NullableString,
  contentRevision: Num,
  metadataRevision: Num,
  captureRevision: Num,
  environmentRevision: Num,
});

const AssetRecord = modelRecord<WebAnnotationAsset>()({
  id: Str,
  environmentId: Str,
  digest: Str,
  mediaType: Str,
  bytes: Num,
  width: Num,
  height: Num,
});

const DestinationOptionRecord = modelRecord<WebAnnotationDestinationOption>()({
  destination: DestinationRecord,
  title: Str,
  isDefault: Schema.Boolean,
  images: Schema.Boolean,
  planMode: Schema.Boolean,
});

const ResponseExcerptRecord = modelRecord<WebAnnotationResponseExcerpt>()({
  text: Str,
  capturedAt: Str,
  truncated: Schema.Boolean,
});

const MigrationStatusRecord = modelRecord<Results["web_annotations_migration_status"]>()({
  environmentId: Str,
  scannedDrafts: Num,
  importedAnnotations: Num,
  pendingDrafts: Num,
  deferredDrafts: Num,
  failedDrafts: Num,
  completedAt: NullableString,
});

const RolloutMode = Schema.Literals(WEB_ANNOTATION_ROLLOUT_MODES);

const RolloutSnapshotRecord = modelRecord<Results["web_annotations_rollout"]>()({
  mode: RolloutMode,
  configured: RolloutMode,
  override: Schema.NullOr(RolloutMode),
});

const envelope = <K extends keyof Results>() => modelRecord<Results[K]>();

// ---------------------------------------------------------------------------
// Commands.

const c = WEB_ANNOTATION_COMMANDS;
const domain = webAnnotationsDomain;

/** Backend support: storage state, rollout mode, operations, targets and limits. */
export const webAnnotationsCapabilitiesCommand = defineCommand({
  domain,
  name: c.capabilities,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: optional(Id) }),
  result: envelope<"web_annotations_capabilities">()({
    contractVersion: Num,
    storage: Schema.Literals(["ready", "degraded", "unavailable"]),
    operations: modelRecord<Results["web_annotations_capabilities"]["operations"]>()({
      read: Schema.Boolean,
      author: Schema.Boolean,
      captureAccept: Schema.Boolean,
      dispatch: Schema.Boolean,
      batch: Schema.Boolean,
      resultTools: Schema.Boolean,
      comparison: Schema.Boolean,
      migration: Schema.Boolean,
    }),
    targets: Strings,
    maxRequestAnnotations: Num,
    limits: opaqueRecord<Results["web_annotations_capabilities"]["limits"]>(),
  }),
  critical: [],
});

export const webAnnotationsListCommand = defineCommand({
  domain,
  name: c.list,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    filter: optional(
      Schema.Struct({
        pageKey: optional(text(4_200)),
        state: optional(Schema.Literals(["open", "resolved", "all"])),
        destinationTabId: optional(Id),
        includeHidden: optional(Schema.Boolean),
        importedOnly: optional(Schema.Boolean),
        includeArchived: optional(Schema.Boolean),
      }),
    ),
    cursor: optional(text(2_000)),
    limit: optional(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(WEB_ANNOTATION_LIMITS.listPageItems),
      ),
    ),
  }),
  result: envelope<"web_annotations_list">()({
    generation: Str,
    revision: Num,
    items: Schema.Array(SummaryRecord),
    nextCursor: NullableString,
    total: Num,
  }),
  critical: [],
});

export const webAnnotationsChangesCommand = defineCommand({
  domain,
  name: c.changes,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, generation: optional(text(100)), after: Revision }),
  result: envelope<"web_annotations_changes">()({
    generation: Str,
    revision: Num,
    resetRequired: Schema.Boolean,
    changes: Schema.Array(
      modelRecord<Results["web_annotations_changes"]["changes"][number]>()({
        revision: Num,
        annotationIds: Strings,
        requestIds: Strings,
      }),
    ),
  }),
  critical: [],
});

export const webAnnotationGetCommand = defineCommand({
  domain,
  name: c.get,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    annotationId: Id,
    entryLimit: optional(EntryLimit),
    entryWindow: optional(Schema.Literals(["oldest", "latest"])),
  }),
  result: envelope<"web_annotation_get">()({
    generation: Str,
    revision: Num,
    annotation: AnnotationRecord,
    capture: Schema.NullOr(CaptureRecord),
    entries: Schema.Array(EntryRecord),
    nextEntrySequence: Schema.NullOr(Num),
    requests: Schema.Array(RequestRecord),
    results: Schema.Array(ResultRecord),
  }),
  critical: [],
});

export const webAnnotationEntriesCommand = defineCommand({
  domain,
  name: c.entries,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    annotationId: Id,
    afterSequence: Revision,
    beforeSequence: optional(Revision),
    limit: optional(EntryLimit),
  }),
  result: envelope<"web_annotation_entries">()({
    entries: Schema.Array(EntryRecord),
    nextSequence: Schema.NullOr(Num),
    resetRequired: Schema.Boolean,
  }),
  critical: [],
});

export const webAnnotationCaptureCommand = defineCommand({
  domain,
  name: c.capture,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, captureId: Id }),
  result: envelope<"web_annotation_capture">()({ capture: CaptureRecord }),
  critical: [],
});

export const webAnnotationDraftGetCommand = defineCommand({
  domain,
  name: c.draftGet,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, editorId: EditorId }),
  result: envelope<"web_annotation_draft_get">()({ draft: Schema.NullOr(DraftRecord) }),
  critical: [],
});

export const webAnnotationDraftSaveCommand = defineCommand({
  domain,
  name: c.draftSave,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    editorId: EditorId,
    expectedRevision: Revision,
    text: text(WEB_ANNOTATION_LIMITS.entryChars * 2),
    annotationId: optional(Schema.NullOr(Id)),
    captureId: optional(Schema.NullOr(Id)),
    pendingCaptureId: optional(Schema.NullOr(Id)),
    operation: optional(Schema.NullOr(Operation)),
    destination: optional(Schema.NullOr(Destination)),
  }),
  result: envelope<"web_annotation_draft_save">()({ draft: DraftRecord }),
  critical: [],
});

export const webAnnotationDraftDeleteCommand = defineCommand({
  domain,
  name: c.draftDelete,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, editorId: EditorId, expectedRevision: Revision }),
  result: envelope<"web_annotation_draft_delete">()({ deleted: Schema.Boolean }),
  critical: [],
});

export const webAnnotationCreateCommand = defineCommand({
  domain,
  name: c.create,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    capture: Capture,
    body: Body,
    title: optional(Title),
    draftId: optional(Id),
    provenance: NoProvenance,
  }),
  result: ReceiptRecord,
  critical: [],
});

export const webAnnotationOperationReceiptCommand = defineCommand({
  domain,
  name: c.receipt,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, operationId: Id }),
  result: envelope<"web_annotation_operation_receipt">()({
    receipt: Schema.NullOr(ReceiptRecord),
  }),
  critical: [],
});

export const webAnnotationEntryAppendCommand = defineCommand({
  domain,
  name: c.entryAppend,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    annotationId: Id,
    expectedContentRevision: Revision,
    body: Body,
    editorId: optional(EditorId),
    provenance: NoProvenance,
  }),
  result: ReceiptRecord,
  critical: [],
});

export const webAnnotationEntryEditCommand = defineCommand({
  domain,
  name: c.entryEdit,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    annotationId: Id,
    entryId: Id,
    expectedContentRevision: Revision,
    body: Body,
    provenance: NoProvenance,
  }),
  result: ReceiptRecord,
  critical: [],
});

export const webAnnotationUpdateCommand = defineCommand({
  domain,
  name: c.update,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    annotationId: Id,
    expectedMetadataRevision: Revision,
    title: optional(Title),
    defaultDestination: optional(Schema.NullOr(Destination)),
    hidden: optional(Schema.Boolean),
  }),
  result: ReceiptRecord,
  critical: [],
});

export const webAnnotationCaptureReplaceCommand = defineCommand({
  domain,
  name: c.captureReplace,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    annotationId: Id,
    expectedContentRevision: Revision,
    capture: Capture,
    body: optional(Body),
    provenance: NoProvenance,
  }),
  result: ReceiptRecord,
  critical: [],
});

export const webAnnotationResolveCommand = defineCommand({
  domain,
  name: c.resolve,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    annotationId: Id,
    expectedContentRevision: Revision,
    expectedCaptureId: Id,
    requestId: optional(Id),
    resultId: optional(Id),
    expectedResultRevision: optional(Revision),
    note: optional(text(WEB_ANNOTATION_LIMITS.entryChars)),
  }),
  result: ReceiptRecord,
  // expectedResultRevision: the compare-and-set guard of accepting a result;
  // a receiver ignoring it would accept a result revised since the user saw it.
  critical: ["expectedResultRevision"],
});

export const webAnnotationReopenCommand = defineCommand({
  domain,
  name: c.reopen,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    annotationId: Id,
    expectedMetadataRevision: Revision,
    body: optional(Body),
    provenance: NoProvenance,
  }),
  result: ReceiptRecord,
  critical: [],
});

export const webAnnotationDeleteCommand = defineCommand({
  domain,
  name: c.delete,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    annotationId: Id,
    expectedMetadataRevision: Revision,
  }),
  result: ReceiptRecord,
  critical: [],
});

export const webAnnotationAssetStageCommand = defineCommand({
  domain,
  name: c.assetStage,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    mediaType: Schema.Literal("image/png"),
    data: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(WEB_ANNOTATION_MAX_ASSET_BASE64_CHARS),
    ),
  }),
  result: envelope<"web_annotation_asset_stage">()({
    asset: AssetRecord,
    deduplicated: Schema.Boolean,
  }),
  critical: [],
});

export const webAnnotationAssetGetCommand = defineCommand({
  domain,
  name: c.assetGet,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, assetId: Id }),
  result: envelope<"web_annotation_asset_get">()({ asset: AssetRecord, data: Str }),
  critical: [],
});

export const webAnnotationDestinationsCommand = defineCommand({
  domain,
  name: c.destinations,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id }),
  result: envelope<"web_annotation_destinations">()({
    options: Schema.Array(DestinationOptionRecord),
  }),
  critical: [],
});

export const webAnnotationRequestPrepareCommand = defineCommand({
  domain,
  name: c.requestPrepare,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operation: Operation,
    destination: Destination,
    annotations: Schema.Array(
      Schema.Struct({
        annotationId: Id,
        expectedContentRevision: Revision,
        expectedCaptureId: Id,
        desiredOutcome: optional(Schema.NullOr(text(WEB_ANNOTATION_LIMITS.desiredOutcomeChars))),
        allowHistoricalEvidence: optional(Schema.Boolean),
      }),
      // Empty only with followUpOf/retargetOf (the service selects defaults).
    ).check(
      Schema.isMaxLength(WEB_ANNOTATION_LIMITS.briefAnnotations, {
        message: `Invalid annotations: a request includes at most ${WEB_ANNOTATION_LIMITS.briefAnnotations} notes`,
      }),
    ),
    instruction: text(WEB_ANNOTATION_LIMITS.instructionChars),
    textOnly: optional(Schema.Boolean),
    followUpOf: optional(Id),
    retargetOf: optional(Id),
    provenance: NoProvenance,
  }),
  result: envelope<"web_annotation_request_prepare">()({
    preparationId: Str,
    expiresAt: Str,
    operation: Str,
    destination: DestinationRecord,
    instruction: Str,
    briefPreview: Str,
    briefBytes: Num,
    bodyHash: Str,
    textOnly: Schema.Boolean,
    sendable: Schema.Boolean,
    issues:
      Schema.Array(opaqueRecord<Results["web_annotation_request_prepare"]["issues"][number]>()),
  }),
  // textOnly: the user chose to send no screenshots; a receiver ignoring it
  // would attach the images they left out. retargetOf: the old request is
  // cancelled in the same commit; ignoring it would dispatch the same notes to
  // two destinations.
  critical: ["textOnly", "retargetOf"],
});

export const webAnnotationRequestSendCommand = defineCommand({
  domain,
  name: c.requestSend,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    preparationId: Id,
    requestId: Id,
    bodyHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
  result: envelope<"web_annotation_request_send">()({
    request: RequestRecord,
    deduplicated: Schema.Boolean,
  }),
  critical: [],
});

export const webAnnotationRequestGetCommand = defineCommand({
  domain,
  name: c.requestGet,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, requestId: Id }),
  result: envelope<"web_annotation_request_get">()({
    request: RequestRecord,
    results: Schema.Array(ResultRecord),
  }),
  critical: [],
});

export const webAnnotationRequestsCommand = defineCommand({
  domain,
  name: c.requestList,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    annotationId: optional(Id),
    activeOnly: optional(Schema.Boolean),
  }),
  result: envelope<"web_annotation_requests">()({ requests: Schema.Array(RequestRecord) }),
  critical: [],
});

export const webAnnotationRequestCancelCommand = defineCommand({
  domain,
  name: c.requestCancel,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, requestId: Id, expectedRevision: Revision }),
  result: envelope<"web_annotation_request_cancel">()({
    request: RequestRecord,
    outcome: Schema.Literals(["cancelled", "cancelling", "not-cancellable"]),
  }),
  critical: [],
});

export const webAnnotationRequestRecoverCommand = defineCommand({
  domain,
  name: c.requestRecover,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    requestId: Id,
    action: Schema.Literals(["reconcile", "retry", "discard"]),
  }),
  result: envelope<"web_annotation_request_recover">()({ request: RequestRecord }),
  critical: [],
});

export const webAnnotationRequestResponseCommand = defineCommand({
  domain,
  name: c.requestResponse,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, requestId: Id }),
  result: envelope<"web_annotation_request_response">()({
    request: RequestRecord,
    response: Schema.NullOr(ResponseExcerptRecord),
    sourceAvailable: Schema.Boolean,
  }),
  critical: [],
});

export const webAnnotationRequestFollowUpCommand = defineCommand({
  domain,
  name: c.requestFollowUp,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, requestId: Id }),
  result: envelope<"web_annotation_request_follow_up">()({
    requestId: Str,
    remaining: Schema.Array(
      modelRecord<Results["web_annotation_request_follow_up"]["remaining"][number]>()({
        annotationId: Str,
        reference: Num,
        reason: Str,
      }),
    ),
    excluded: Schema.Array(
      modelRecord<Results["web_annotation_request_follow_up"]["excluded"][number]>()({
        annotationId: Str,
        reference: Num,
        reason: Str,
      }),
    ),
    resultId: NullableString,
  }),
  critical: [],
});

const Coordinate = Schema.Finite;

export const webAnnotationResultCaptureCommand = defineCommand({
  domain,
  name: c.resultCapture,
  since: 1,
  access: "workspace",
  read: false,
  // Comparison metadata is optional and bounds-checked by the service
  // (`validateWebAnnotationResultCaptureMetadata`).
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    requestId: Id,
    annotationId: optional(Id),
    capture: Capture,
    zoomFactor: optional(Schema.Finite),
    deviceScaleFactor: optional(Schema.Finite),
    scroll: optional(Schema.Struct({ x: Coordinate, y: Coordinate })),
    stability: optional(Schema.Literals(["stable", "unstable"])),
    masks: optional(
      Schema.Array(
        Schema.Struct({
          source: Schema.Literals(["sensitive-field", "manual"]),
          rect: Schema.Struct({
            x: Coordinate,
            y: Coordinate,
            width: Coordinate,
            height: Coordinate,
          }),
        }),
      ).check(Schema.isMaxLength(WEB_ANNOTATION_LIMITS.redactionRegions)),
    ),
    targetResolution: optional(Schema.Unknown),
    provenance: NoProvenance,
  }),
  result: envelope<"web_annotation_result_capture">()({ result: ResultRecord, captureId: Str }),
  critical: [],
});

export const webAnnotationsMigrateCommand = defineCommand({
  domain,
  name: c.migrate,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id }),
  result: MigrationStatusRecord,
  critical: [],
});

export const webAnnotationsMigrationStatusCommand = defineCommand({
  domain,
  name: c.migrationStatus,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id }),
  result: MigrationStatusRecord,
  critical: [],
});

export const webAnnotationArchiveCommand = defineCommand({
  domain,
  name: c.archive,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    operationId: Id,
    annotationId: Id,
    expectedMetadataRevision: Revision,
    title: optional(Title),
    body: optional(Body),
    provenance: NoProvenance,
  }),
  result: envelope<"web_annotation_archive">()({
    continuation: ReceiptRecord,
    archivedAnnotationId: Str,
    archivedMetadataRevision: Num,
  }),
  critical: [],
});

export const webAnnotationsReconcileDraftCommand = defineCommand({
  domain,
  name: c.reconcileDraft,
  since: 1,
  access: "workspace",
  read: false,
  // `value` was `z.unknown()`, which a missing key satisfied; the service reads it.
  args: Schema.Struct({ environmentId: Id, value: optional(Schema.Unknown) }),
  result: envelope<"web_annotations_reconcile_draft">()({
    value: Schema.Unknown,
    references: Schema.Array(
      modelRecord<Results["web_annotations_reconcile_draft"]["references"][number]>()({
        legacyId: Str,
        annotationId: Str,
      }),
    ),
    imported: Num,
    failed: Strings,
  }),
  critical: [],
});

export const webAnnotationsRolloutCommand = defineCommand({
  domain,
  name: c.rollout,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({}),
  result: RolloutSnapshotRecord,
  critical: [],
});

export const webAnnotationsRolloutSetCommand = defineCommand({
  domain,
  name: c.rolloutSet,
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ mode: RolloutMode }),
  result: RolloutSnapshotRecord,
  critical: [],
});

export const webAnnotationsMetricsCommand = defineCommand({
  domain,
  name: c.metrics,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({}),
  result: envelope<"web_annotations_metrics">()({
    counters: Schema.Record(Schema.String, Schema.Finite),
    durations: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
    gauges: Schema.Record(Schema.String, Schema.Finite),
    droppedSeries: Num,
  }),
  critical: [],
});

/** Every `web-annotations` command, in `WEB_ANNOTATION_COMMANDS` order. */
export const WEB_ANNOTATIONS_COMMANDS = [
  webAnnotationsCapabilitiesCommand,
  webAnnotationsListCommand,
  webAnnotationsChangesCommand,
  webAnnotationGetCommand,
  webAnnotationEntriesCommand,
  webAnnotationCaptureCommand,
  webAnnotationDraftGetCommand,
  webAnnotationDraftSaveCommand,
  webAnnotationDraftDeleteCommand,
  webAnnotationCreateCommand,
  webAnnotationOperationReceiptCommand,
  webAnnotationEntryAppendCommand,
  webAnnotationEntryEditCommand,
  webAnnotationUpdateCommand,
  webAnnotationCaptureReplaceCommand,
  webAnnotationResolveCommand,
  webAnnotationReopenCommand,
  webAnnotationDeleteCommand,
  webAnnotationAssetStageCommand,
  webAnnotationAssetGetCommand,
  webAnnotationDestinationsCommand,
  webAnnotationRequestPrepareCommand,
  webAnnotationRequestSendCommand,
  webAnnotationRequestGetCommand,
  webAnnotationRequestsCommand,
  webAnnotationRequestCancelCommand,
  webAnnotationRequestRecoverCommand,
  webAnnotationRequestResponseCommand,
  webAnnotationRequestFollowUpCommand,
  webAnnotationResultCaptureCommand,
  webAnnotationsMigrateCommand,
  webAnnotationsMigrationStatusCommand,
  webAnnotationArchiveCommand,
  webAnnotationsReconcileDraftCommand,
  webAnnotationsRolloutCommand,
  webAnnotationsRolloutSetCommand,
  webAnnotationsMetricsCommand,
] as const;

/** The definitions by command name. */
export type WebAnnotationsCommandDef = (typeof WEB_ANNOTATIONS_COMMANDS)[number];
export type WebAnnotationsCommandName = WebAnnotationsCommandDef["name"];
export type WebAnnotationsCommandOf<N extends WebAnnotationsCommandName> = Extract<
  WebAnnotationsCommandDef,
  { readonly name: N }
>;

export const WEB_ANNOTATIONS_COMMAND_BY_NAME: Readonly<
  Record<WebAnnotationsCommandName, WebAnnotationsCommandDef>
> = Object.freeze(
  Object.fromEntries(WEB_ANNOTATIONS_COMMANDS.map((def) => [def.name, def])) as Record<
    WebAnnotationsCommandName,
    WebAnnotationsCommandDef
  >,
);
