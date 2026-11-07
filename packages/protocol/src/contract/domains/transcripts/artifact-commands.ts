/**
 * `transcripts` commands for transcript artifacts and media (plan item 7004):
 * reading published artifacts and drafts, live interactive sessions, Mermaid
 * rendering, workflow snapshots, staged assets, media streams, PDF previews,
 * the preview worker, and media pins. Plan item 7001 adds the domain's prompt,
 * queue, handoff and sync commands beside these.
 *
 * The artifact handlers were lenient and validate their arguments
 * themselves, rejecting with an `Error` whose message is the JSON text of an
 * `ArtifactError` (`{"code":"invalid_input",…}`), which the renderer parses.
 * So each argument a handler checks is `optionalKey(Unknown)` here: a schema
 * refusal would lose that code and refuse values the handler accepts today
 * (§11.4). `transcript_media_pin` was strict (it refused unknown keys); it is
 * tolerant now, like every defined command.
 *
 * Results are the protocol's records (`transcript-artifact-commands.ts`,
 * `transcript-media-pins.ts`); nested records are {@link modelRecord}s that
 * validate their identity and state fields and pass the rest through.
 *
 * `read` follows the routing classifier (`isNodeReadCommand`), which reads
 * none of these names as a read; see the plan item's Notes.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  ArtifactDraftSummary,
  ArtifactLiveSessionResponse,
  ArtifactPrepareWorkerResponse,
  ArtifactPublicationView,
  ArtifactRepresentationResponse,
  TranscriptArtifactCapabilities,
  TranscriptMediaPdfPreviewResponse,
} from "../../../transcript-artifact-commands.js";
import {
  ARTIFACT_ERROR_CODES,
  ARTIFACT_KINDS,
  type ArtifactError,
  type TranscriptArtifactRef,
} from "../../../transcript-artifacts.js";
import type { WorkflowSnapshotV1 } from "../../../workflow-snapshot.js";
import { defineCommand } from "../../command.js";
import { modelRecord } from "../../model-schema.js";
import { transcriptsDomain } from "./domain.js";

const checked = Schema.optionalKey(Schema.Unknown);
const Count = Schema.Finite;
const Kind = Schema.Literals(ARTIFACT_KINDS);
const Isolation = Schema.Literals(["container", "process", "unavailable"]);
const Representation = Schema.Literals([
  "source",
  "effective-html",
  "prepared-html",
  "capture",
  "rendered-svg",
  "chart-json",
  "chart-csv",
  "workflow-json",
  "pdf",
  "diagnostic-capture",
]);

/** The conversation every read names; the handler answers `not_found` for anything it does not own. */
const conversation = { environmentId: checked, logicalSessionKey: checked };

export const ArtifactErrorSchema = modelRecord<ArtifactError>()({
  code: Schema.Literals(ARTIFACT_ERROR_CODES),
  message: Schema.String,
  retryClass: Schema.Literals(["never", "after-edit", "after-refresh", "transient"]),
});

export const TranscriptArtifactRefSchema = modelRecord<TranscriptArtifactRef>()({
  schemaVersion: Schema.Literal(1),
  artifactId: Schema.String,
  revision: Count,
  publicationId: Schema.String,
  kind: Kind,
  title: Schema.String,
});

export const TranscriptArtifactCapabilitiesSchema = modelRecord<TranscriptArtifactCapabilities>()({
  backendId: Schema.String,
  authoring: Schema.Boolean,
  previewRenderer: modelRecord<TranscriptArtifactCapabilities["previewRenderer"]>()({
    available: Schema.Boolean,
    isolation: Isolation,
  }),
  liveInteractive: Schema.Boolean,
  contentOrigin: Schema.NullOr(Schema.String),
  rolloutFlags: modelRecord<TranscriptArtifactCapabilities["rolloutFlags"]>()({
    richMarkdown: Schema.Boolean,
    artifactPublication: Schema.Boolean,
    liveInteractive: Schema.Boolean,
  }),
});

export const ArtifactPublicationViewSchema = modelRecord<ArtifactPublicationView>()({
  ref: TranscriptArtifactRefSchema,
  publishedAt: Schema.String,
  conversationSequence: Count,
  kind: Kind,
  receipt: modelRecord<ArtifactPublicationView["receipt"]>()({
    receiptId: Schema.String,
    completedAt: Schema.String,
    semantics: Schema.Literals(["not-assessed", "probes-passed"]),
  }),
  source: Schema.Struct({
    sha256: Schema.String,
    byteLength: Count,
    effectiveSha256: Schema.String,
  }),
  availability: Schema.Literals(["available", "storage_corrupt", "missing"]),
});

export const ArtifactPublicationListSchema = Schema.Struct({
  publications: Schema.Array(ArtifactPublicationViewSchema),
  nextSequence: Schema.NullOr(Count),
});

export const ArtifactRepresentationResponseSchema = modelRecord<ArtifactRepresentationResponse>()({
  artifactId: Schema.String,
  revision: Count,
  representation: Representation,
  mimeType: Schema.String,
  filename: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  data: Schema.String,
  sha256: Schema.String,
  byteLength: Count,
  totalBytes: Count,
  nextOffsetBytes: Schema.NullOr(Count),
  executableOutsideOrkestrator: Schema.Boolean,
});

export const ArtifactLiveSessionResponseSchema = modelRecord<ArtifactLiveSessionResponse>()({
  contentUrl: Schema.String,
  shellUrl: Schema.String,
  expiresAt: Schema.String,
  preparedSha256: Schema.String,
  artifactId: Schema.String,
  revision: Count,
  generation: Schema.String,
  readinessNonce: Schema.String,
});

export const MermaidRenderResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    svg: Schema.String,
    diagramType: Schema.String,
    rendererVersion: Schema.String,
    svgBytes: Count,
    svgElements: Count,
    edges: Count,
    renderDigest: Schema.String,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: modelRecord<ArtifactError & { line?: number; column?: number }>()({
      code: Schema.Literals(ARTIFACT_ERROR_CODES),
      message: Schema.String,
      retryClass: Schema.Literals(["never", "after-edit", "after-refresh", "transient"]),
    }),
  }),
]);
export type MermaidRenderResult = typeof MermaidRenderResponseSchema.Type;

export const WorkflowSnapshotSchema = modelRecord<WorkflowSnapshotV1>()({
  schemaVersion: Schema.Literal(1),
  workflowId: Schema.String,
  runId: Schema.String,
  sourceRevision: Schema.String,
  capturedAt: Schema.String,
  status: Schema.String,
});

/** The current state of a workflow run, read separately from any published snapshot. */
export const WorkflowLiveSnapshotResponseSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    snapshot: WorkflowSnapshotSchema,
    terminal: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["deleted", "not_found", "unsupported", "error"]),
    message: Schema.String,
  }),
]);
export type WorkflowLiveSnapshotResponse = typeof WorkflowLiveSnapshotResponseSchema.Type;

export const ArtifactDraftSummarySchema = modelRecord<ArtifactDraftSummary>()({
  artifactId: Schema.String,
  kind: Kind,
  title: Schema.String,
  currentRevision: Count,
  publishedRevision: Schema.NullOr(Count),
  updatedAt: Schema.String,
});

export const ArtifactDraftListSchema = Schema.Struct({
  drafts: Schema.Array(ArtifactDraftSummarySchema),
});

export const ArtifactStageAssetResponseSchema = Schema.Struct({
  assetRef: Schema.String,
  sha256: Schema.String,
  byteLength: Count,
  mimeType: Schema.String,
  expiresAt: Schema.String,
});

export const TranscriptMediaStreamResponseSchema = Schema.Struct({
  url: Schema.String,
  mimeType: Schema.String,
  byteLength: Count,
  expiresAt: Schema.String,
  streamId: Schema.String,
});

export const TranscriptMediaPdfPreviewResponseSchema =
  modelRecord<TranscriptMediaPdfPreviewResponse>()({
    status: Schema.Literals(["ready", "refused", "unavailable"]),
    sha256: Schema.NullOr(Schema.String),
    byteLength: Schema.NullOr(Count),
    pageCount: Schema.NullOr(Count),
    limits: Schema.Struct({ maxPages: Count, maxBytes: Count }),
  });

export const ArtifactPrepareWorkerResponseSchema = modelRecord<ArtifactPrepareWorkerResponse>()({
  available: Schema.Boolean,
  state: Schema.Literals(["idle", "preparing", "ready", "failed"]),
  method: Schema.NullOr(Schema.Literals(["build", "pull"])),
  isolation: Isolation,
  interactiveIsolation: Isolation,
});

export const TranscriptMediaPinResponseSchema = Schema.Struct({
  status: Schema.Literals(["pinned", "live"]),
  capturedAt: Schema.String,
  fileModifiedAt: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.Literals(["quota", "missing"])),
  sha256: Schema.String,
  byteLength: Count,
  dataBase64: Schema.String,
});

export const transcriptArtifactCapabilitiesCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_capabilities",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({}),
  result: TranscriptArtifactCapabilitiesSchema,
  critical: [],
});

export const transcriptArtifactGetPublicationCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_get_publication",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...conversation, publicationId: checked }),
  result: ArtifactPublicationViewSchema,
  critical: [],
});

export const transcriptArtifactListPublicationsCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_list_publications",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...conversation, afterSequence: checked, limit: checked }),
  result: ArtifactPublicationListSchema,
  critical: [],
});

export const transcriptArtifactReadRepresentationCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_read_representation",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...conversation,
    publicationId: checked,
    representation: checked,
    paper: checked,
    captureIndex: checked,
    sourceRange: checked,
  }),
  result: ArtifactRepresentationResponseSchema,
  critical: [],
});

export const transcriptArtifactOpenLiveSessionCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_open_live_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...conversation, publicationId: checked }),
  result: ArtifactLiveSessionResponseSchema,
  critical: [],
});

export const transcriptArtifactCloseLiveSessionCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_close_live_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ generation: checked }),
  result: Schema.Null,
  critical: [],
});

export const transcriptArtifactRenderMermaidCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_render_mermaid",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ source: checked, theme: checked }),
  result: MermaidRenderResponseSchema,
  critical: [],
});

export const transcriptArtifactWorkflowLiveSnapshotCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_workflow_live_snapshot",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: checked, workflowId: checked, runId: checked }),
  result: WorkflowLiveSnapshotResponseSchema,
  critical: [],
});

export const transcriptArtifactListDraftsCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_list_drafts",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...conversation, limit: checked }),
  result: ArtifactDraftListSchema,
  critical: [],
});

export const transcriptArtifactReadDraftCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_read_draft",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...conversation,
    artifactId: checked,
    representation: checked,
    revision: checked,
    operationId: checked,
    captureIndex: checked,
    sourceRange: checked,
  }),
  result: ArtifactRepresentationResponseSchema,
  critical: [],
});

export const transcriptArtifactStageAssetCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_stage_asset",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...conversation, name: checked, mimeType: checked, dataBase64: checked }),
  result: ArtifactStageAssetResponseSchema,
  critical: [],
});

export const transcriptMediaOpenStreamCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_media_open_stream",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: checked, path: checked, containerId: checked }),
  result: TranscriptMediaStreamResponseSchema,
  // containerId: names the container the path is in; ignoring it would serve the host
  // file of the same name instead.
  critical: ["containerId"],
});

export const transcriptMediaCloseStreamCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_media_close_stream",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ streamId: checked }),
  result: Schema.Null,
  critical: [],
});

export const transcriptMediaPdfPreviewCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_media_pdf_preview",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: checked, source: checked }),
  result: TranscriptMediaPdfPreviewResponseSchema,
  critical: [],
});

export const transcriptArtifactPrepareWorkerCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_artifact_prepare_worker",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({}),
  result: ArtifactPrepareWorkerResponseSchema,
  critical: [],
});

export const transcriptMediaPinCommand = defineCommand({
  domain: transcriptsDomain,
  name: "transcript_media_pin",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...conversation,
    messageId: checked,
    path: checked,
    containerId: checked,
  }),
  result: TranscriptMediaPinResponseSchema,
  // containerId: as for transcript_media_open_stream, ignoring it would pin the host file
  // of the same name.
  critical: ["containerId"],
});

/** Every transcript artifact and media command (plan item 7004). */
export const TRANSCRIPT_ARTIFACT_DEFINITIONS = [
  transcriptArtifactCapabilitiesCommand,
  transcriptArtifactGetPublicationCommand,
  transcriptArtifactListPublicationsCommand,
  transcriptArtifactReadRepresentationCommand,
  transcriptArtifactOpenLiveSessionCommand,
  transcriptArtifactCloseLiveSessionCommand,
  transcriptArtifactRenderMermaidCommand,
  transcriptArtifactWorkflowLiveSnapshotCommand,
  transcriptArtifactListDraftsCommand,
  transcriptArtifactReadDraftCommand,
  transcriptArtifactStageAssetCommand,
  transcriptMediaOpenStreamCommand,
  transcriptMediaCloseStreamCommand,
  transcriptMediaPdfPreviewCommand,
  transcriptArtifactPrepareWorkerCommand,
  transcriptMediaPinCommand,
] as const;
