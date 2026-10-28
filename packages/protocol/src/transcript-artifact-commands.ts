/**
 * Backend commands the renderer uses to read transcript artifacts.
 *
 * Every read names the conversation it is displayed in
 * (`environmentId` + `logicalSessionKey`); the backend loads the record and
 * answers `not_found` unless that conversation owns it, exactly as it would
 * for a record that does not exist. Identifiers are locators, not
 * capabilities. Content is returned by exact revision and hash.
 */
import type {
  ArtifactKind,
  ArtifactError,
  ArtifactOperation,
  ArtifactPreviewProfile,
  TranscriptArtifactRef,
} from "./transcript-artifacts.js";
import type { ArtifactDiagnostic, ArtifactCapture } from "./transcript-artifacts.js";

export const TRANSCRIPT_ARTIFACT_COMMANDS = {
  capabilities: "transcript_artifact_capabilities",
  getPublication: "transcript_artifact_get_publication",
  listPublications: "transcript_artifact_list_publications",
  readRepresentation: "transcript_artifact_read_representation",
  openLiveSession: "transcript_artifact_open_live_session",
  closeLiveSession: "transcript_artifact_close_live_session",
  renderMermaid: "transcript_artifact_render_mermaid",
  workflowLiveSnapshot: "transcript_artifact_workflow_live_snapshot",
  listDrafts: "transcript_artifact_list_drafts",
  readDraft: "transcript_artifact_read_draft",
  stageAsset: "transcript_artifact_stage_asset",
  openMediaStream: "transcript_media_open_stream",
  closeMediaStream: "transcript_media_close_stream",
  mediaPdfPreview: "transcript_media_pdf_preview",
  prepareWorker: "transcript_artifact_prepare_worker",
} as const;

export interface ArtifactConversationScope {
  environmentId: string;
  logicalSessionKey: string;
}

export interface TranscriptArtifactCapabilities {
  /** Authenticated backend identity; published refs from another backend are not authoritative here. */
  backendId: string;
  authoring: boolean;
  /** Headless preview available for HTML and Mermaid. */
  previewRenderer: {
    available: boolean;
    reason?: string;
    isolation: "container" | "process" | "unavailable";
    /** Isolation used for authored JavaScript (interactive previews), which may differ. */
    interactiveIsolation?: "container" | "process" | "unavailable";
    interactiveReason?: string;
    /** Worker slots held because a worker's exit could not be verified yet. */
    quarantinedWorkers?: number;
  };
  /** Why live interactive viewing is off on this backend, when it is. */
  liveInteractiveReason?: string;
  /** Live interactive viewing is enabled (rollout control). */
  liveInteractive: boolean;
  /** Dedicated content listener origin for executable documents, when serving. */
  contentOrigin: string | null;
  rolloutFlags: { richMarkdown: boolean; artifactPublication: boolean; liveInteractive: boolean };
  /**
   * Whether this backend can build (or pull) the isolated container preview
   * worker on demand (`transcript_artifact_prepare_worker`), and the state of
   * the last preparation. Absent on backends without the capability.
   */
  workerPreparation?: ArtifactWorkerPreparationStatus;
}

/** State of the on-demand container preview worker preparation. */
export interface ArtifactWorkerPreparationStatus {
  /** A Docker CLI and a shipped worker build context (or published image pin) exist. */
  available: boolean;
  state: "idle" | "preparing" | "ready" | "failed";
  /** `build`: from the shipped build context; `pull`: the published, digest-pinned image. */
  method: "build" | "pull" | null;
  /** Why preparation is unavailable or failed. Content-free. */
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Image reference in use after a successful preparation. */
  image?: string;
  /**
   * A worker image prepared on this host earlier is present but was built
   * from another build context than this backend ships (usually by the
   * version before an upgrade). Under `auto` it is not used; preparing again
   * replaces it.
   */
  outdated?: boolean;
}

export type ArtifactPrepareWorkerResponse = ArtifactWorkerPreparationStatus & {
  /** Preview isolation after re-running auto-selection. */
  isolation: "container" | "process" | "unavailable";
  interactiveIsolation: "container" | "process" | "unavailable";
};

export interface ArtifactPublicationView {
  ref: TranscriptArtifactRef;
  publishedAt: string;
  conversationSequence: number;
  kind: ArtifactKind;
  receipt: {
    receiptId: string;
    completedAt: string;
    profile: ArtifactPreviewProfile | null;
    captures: Array<
      Pick<ArtifactCapture, "assetId" | "sha256" | "width" | "height" | "byteLength">
    >;
    probeSummary?: { total: number; passed: number };
    semantics: "not-assessed" | "probes-passed";
    rendererOutput?: { sha256: string; mimeType: string; byteLength: number };
  };
  source: { sha256: string; byteLength: number; effectiveSha256: string };
  /** Workflow snapshot metadata surfaced without loading the body. */
  workflow?: { workflowId: string; runId: string; sourceRevision: string; capturedAt: string };
  /**
   * Backend dispatch correlation recorded at publication: the turn that
   * published and, when the provider reported one, the publishing tool call.
   * Lets the transcript place the item beside that call instead of in a
   * separately attributed row.
   */
  anchor?: { turnId?: string; toolCallId?: string };
  /** Present when a stored asset is missing or corrupt: render the summary with an unavailable state. */
  availability: "available" | "storage_corrupt" | "missing";
}

export type ArtifactRepresentation =
  | "source"
  | "effective-html"
  | "prepared-html"
  | "capture"
  | "rendered-svg"
  | "chart-json"
  | "chart-csv"
  | "workflow-json"
  /**
   * HTML artifacts only: a PDF of the exact verified revision printed by the
   * isolated preview worker under a fixed print profile (`paper`). Produced
   * on demand, then stored; always an attachment.
   */
  | "pdf";

/** Paper of the fixed artifact print profile. */
export type ArtifactPrintPaper = "a4" | "letter";

export interface ArtifactRepresentationRequest extends ArtifactConversationScope {
  publicationId: string;
  representation: ArtifactRepresentation;
  captureIndex?: number;
  /** `pdf` only: the print profile's paper (default `a4`). */
  paper?: ArtifactPrintPaper;
  /** Byte range of a UTF-8 representation, for bounded source views. */
  sourceRange?: { offsetBytes: number; limitBytes: number };
}

export interface ArtifactRepresentationResponse {
  artifactId: string;
  revision: number;
  representation: ArtifactRepresentation;
  mimeType: string;
  /** Sanitized independently of the title. */
  filename: string;
  encoding: "utf8" | "base64";
  data: string;
  sha256: string;
  byteLength: number;
  totalBytes: number;
  nextOffsetBytes: number | null;
  /** HTML exports run outside Orkestrator's isolation once saved. */
  executableOutsideOrkestrator: boolean;
  /** `pdf` only: the print profile the PDF was produced under and its page count. */
  print?: {
    profileVersion: string;
    /** SHA-256 identity of the full print profile. */
    profileHash: string;
    paper: ArtifactPrintPaper;
    pageCount: number;
    /** The verification receipt of the revision that was printed. */
    receiptId: string;
  };
}

export interface ArtifactLiveSessionResponse {
  /** Short-lived capability URL for exactly one prepared document. */
  contentUrl: string;
  /**
   * The trusted viewer shell for the same capability, on the same content
   * origin (`/s/<capability>`): it frames exactly `contentUrl` (path-exact
   * `frame-src`) and relays the presentation channel. Browser mode loads this,
   * never `contentUrl` directly; the desktop host has its own shell.
   */
  shellUrl: string;
  expiresAt: string;
  preparedSha256: string;
  artifactId: string;
  revision: number;
  /** Fresh per live session; never a secret. */
  generation: string;
  readinessNonce: string;
}

export interface MermaidRenderRequest {
  source: string;
  theme: "light" | "dark";
}

export type MermaidRenderResponse =
  | {
      ok: true;
      svg: string;
      diagramType: string;
      rendererVersion: string;
      svgBytes: number;
      svgElements: number;
      edges: number;
      renderDigest: string;
    }
  | {
      ok: false;
      error: ArtifactError & { line?: number; column?: number };
    };

export interface ArtifactOperationView {
  operation: ArtifactOperation;
  diagnostics: ArtifactDiagnostic[];
}

/**
 * A conversation's artifacts as their author left them, published or not, so
 * a person can inspect and copy draft source and failed-preview evidence
 * even when nothing was published. Owner-scoped exactly like publications.
 */
export interface ArtifactDraftSummary {
  artifactId: string;
  kind: ArtifactKind;
  title: string;
  summary: string;
  currentRevision: number;
  publishedRevision: number | null;
  updatedAt: string;
  /** Most recent verification of the current revision, if any. */
  latestOperation: {
    operationId: string;
    revision: number;
    status: ArtifactOperation["status"];
    error?: ArtifactError;
    diagnostics: ArtifactDiagnostic[];
    omittedDiagnostics: number;
    diagnosticCaptureCount: number;
    semantics: ArtifactOperation["semantics"];
  } | null;
}

export interface ArtifactDraftReadRequest extends ArtifactConversationScope {
  artifactId: string;
  /** Defaults to the current revision. */
  revision?: number;
  representation: "source" | "diagnostic-capture";
  /** Required for `diagnostic-capture`. */
  operationId?: string;
  captureIndex?: number;
  sourceRange?: { offsetBytes: number; limitBytes: number };
}

export interface ArtifactDraftListResponse {
  /** Newest first (by last change), at most 100. */
  drafts: ArtifactDraftSummary[];
}

/**
 * Stage a bounded upload for use as an artifact asset. The bytes are stored
 * content-addressed in the environment's artifact asset store, owned by this
 * conversation; the returned `assetRef` is usable only by that conversation
 * (as `draft.assets[].assetRef`). The MIME type must match the bytes.
 */
export interface ArtifactStageAssetRequest extends ArtifactConversationScope {
  /** Logical name (letters, digits, '.', '_' and '-'); never a path. */
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface ArtifactStageAssetResponse {
  assetRef: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
  /** Staged references expire with unpublished drafts when no revision uses them. */
  expiresAt: string;
}

/**
 * Largest host file (bytes) served through a media stream capability. Host
 * files are read in place with ranged reads, so this only bounds what one
 * capability can expose.
 */
export const TRANSCRIPT_MEDIA_STREAM_MAX_HOST_BYTES = 2 * 1024 * 1024 * 1024;
/** Largest container file (bytes) copied once into backend staging for streaming. */
export const TRANSCRIPT_MEDIA_STREAM_MAX_CONTAINER_BYTES = 512 * 1024 * 1024;

/**
 * Open a short-lived, range-capable capability URL on the artifact content
 * origin for one environment file (audio, video or image). The backend
 * resolves the file only through its confined readers: a host path must lie
 * in the environment's worktree (no symbolic links), a container path in
 * `/workspace` of the environment's own container. The type is sniffed from
 * the bytes; only `audio/*`, `video/*` and `image/*` (never SVG) are served.
 *
 * Failures reject with an `ArtifactError` JSON message: `invalid_input`,
 * `not_found` (no such environment or file), `policy_denied` (outside the
 * workspace, a symbolic link, not a regular file), `unsupported_kind` (the
 * bytes are not a served media type), `package_size_exceeded` (over the
 * maximum), `capacity_exceeded` (staging quota or concurrency), and
 * `renderer_unavailable` (no content origin: use the bounded base64 path).
 */
export interface TranscriptMediaStreamRequest {
  environmentId: string;
  /** Absolute host path or worktree-relative path; for containers, `/workspace/…` or relative. */
  path: string;
  /** Must name the environment's own container when given. */
  containerId?: string;
}

export interface TranscriptMediaStreamResponse {
  /** Bearer capability URL on the content origin; never log it. */
  url: string;
  /** Sniffed from the bytes, not the file name. */
  mimeType: string;
  byteLength: number;
  expiresAt: string;
  /** Close handle for `transcript_media_close_stream`; not a secret. */
  streamId: string;
}

/** Where a PDF attachment's bytes are read from: only the backend's authorized readers. */
export type TranscriptMediaPdfSource =
  /** Absolute host path (`read_file_base64` roots) or, with `containerId`, a `/workspace` path. */
  | { path: string; containerId?: string }
  /** Deferred tool detail of this conversation (`get_native_agent_tool_details`). */
  | { detailRef: string; agent: string; logicalSessionKey: string };

export interface TranscriptMediaPdfPreviewRequest {
  environmentId: string;
  source: TranscriptMediaPdfSource;
}

/**
 * First-page preview of a PDF attachment, rendered by pdf.js inside the
 * isolated, network-denied preview worker (no PDF scripting, XFA or eval).
 * Files over the page or byte ceiling get metadata only; the original stays
 * downloadable through the normal attachment path.
 */
export interface TranscriptMediaPdfPreviewResponse {
  status: "ready" | "refused" | "unavailable";
  /** SHA-256 of the exact bytes read (the cache key). */
  sha256: string | null;
  byteLength: number | null;
  /** Known when the document could be opened. */
  pageCount: number | null;
  /** `ready` only: page 1, bounded PNG. */
  thumbnail?: { dataBase64: string; mimeType: "image/png"; width: number; height: number };
  /**
   * `refused`: `page-limit`, `byte-limit`, `not-pdf`, `invalid-pdf` or
   * `encrypted`; `unavailable`: `renderer-unavailable`, `read-failed` or
   * `capacity`.
   */
  reason?: string;
  message?: string;
  limits: { maxPages: number; maxBytes: number };
}
