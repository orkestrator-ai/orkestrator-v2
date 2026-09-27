import type { DesignCanvas, DesignFrame, DesignHistoryStatus } from "./design-canvas.js";

/**
 * Protocol v2 design contracts: recoverable operations, private workspace
 * metadata, incremental sync, history, export and library summaries.
 *
 * Portable `.orkdes` documents stay version 1 (`DesignCanvas`). Everything in
 * this module is backend/workspace metadata and must never be written into a
 * portable export.
 */
export const DESIGN_PROTOCOL_VERSION = 2;
export const DESIGN_RESPONSE_VERSION = 1;

/** Centralized engineering budgets. Revise with measurements, not guesses. */
export const DESIGN_LIMITS = {
  admittedMutations: 32,
  admittedMutationsPerCanvas: 8,
  admittedPayloadBytes: 8 * 1024 * 1024,
  preparedPerCanvas: 8,
  privateRecordBytes: 6 * 1024 * 1024,
  receiptsPerCanvas: 128,
  receiptBytesPerCanvas: 128 * 1024,
  provisionalCanvases: 16,
  provisionalTtlMs: 10 * 60_000,
  preparedTtlMs: 30 * 60_000,
  renderJobs: 16,
  renderWorkers: 1,
  historyEntriesPerCanvas: 50,
  historyBytesPerCanvas: 64 * 1024 * 1024,
  historyBytesGlobal: 512 * 1024 * 1024,
  recycleCanvases: 32,
  recycleBytes: 128 * 1024 * 1024,
  recycleRetentionMs: 7 * 24 * 60 * 60_000,
  captureCacheEntries: 64,
  captureCacheBytes: 64 * 1024 * 1024,
  changeDescriptors: 256,
  deltaBytes: 256 * 1024,
  deltaFrames: 64,
  batchOperations: 16,
  batchBytes: 512 * 1024,
  sessionLinksPerCanvas: 8,
  exportBackups: 16,
  hierarchyPageNodes: 200,
  hierarchyPageBytes: 128 * 1024,
  diagnosticReasons: 16,
  libraryPageSize: 50,
  healthCacheMs: 60_000,
  contextReferenceBytes: 4 * 1024,
  handoffFrames: 8,
  handoffBytes: 32 * 1024,
} as const;

export interface DesignCapabilities {
  protocolVersion: number;
  responseVersion: number;
  snapshot: boolean;
  operations: boolean;
  sync: boolean;
  save: boolean;
  history: boolean;
  lifecycle: boolean;
  rendererHealth: boolean;
  library: boolean;
  batch: boolean;
  sessions: boolean;
  validation: boolean;
  hierarchyPaging: boolean;
}

export type DesignFailureCode =
  | "conflict"
  | "invalid-input"
  | "invalid-content"
  | "renderer-unavailable"
  | "capacity"
  | "deadline"
  | "disconnected"
  | "deleted"
  | "not-found"
  | "forbidden"
  | "expired-operation"
  | "unknown-outcome"
  | "unsupported"
  | "storage"
  | "export-collision"
  | "history-ineligible";

export type DesignRetryClass = "never" | "after-refresh" | "after-delay" | "safe" | "review";

export interface DesignFailure {
  code: DesignFailureCode;
  message: string;
  retry: DesignRetryClass;
  target?: { canvasId?: string; frameId?: string; selector?: string };
  revisions?: { expected?: number; current?: number };
  retryAfterMs?: number;
  /** Bounded, content-free detail (property names, counts, reason codes). */
  details?: Record<string, string | number | boolean | string[]>;
}

export type DesignActor = "user" | "agent" | "system";

/** Opaque identities; equal strings mean equal content/structure/viewport. */
export interface DesignFrameIdentity {
  contentId: string;
  structureId: string;
  viewportId: string;
}

export type DesignValidationState =
  | "unvalidated"
  | "validating"
  | "valid"
  | "invalid"
  | "renderer-unavailable";

export type DesignValidationReason =
  | "scripts-removed"
  | "handlers-removed"
  | "external-references-blocked"
  | "forbidden-elements-removed"
  | "executable-urls-removed"
  | "dom-limit"
  | "html-limit"
  | "invalid-selector"
  | "runtime-timeout"
  | "renderer-unavailable"
  | "runtime-error";

export interface DesignFrameValidation {
  frameId: string;
  contentId: string;
  runtimeVersion: number;
  state: DesignValidationState;
  reasons: Array<{ code: DesignValidationReason; count?: number }>;
  truncated: boolean;
  elementCount?: number;
  validatedAt?: string;
  /** Safe, content-free description. */
  message?: string;
}

export interface DesignFrameMeta extends DesignFrameIdentity {
  validation: DesignFrameValidation;
  modifiedAt: string;
}

export interface DesignExportAssociation {
  relativePath: string;
  repository: string;
  lastExportedRevision: number;
  digest: string;
  exportedAt: string;
  token?: string;
}

export interface DesignPendingExport {
  token: string;
  relativePath: string;
  repository: string;
  revision: number;
  digest: string;
  startedAt: string;
  state: "writing" | "unknown" | "failed";
  failure?: DesignFailure;
}

export type DesignSessionRole = "design" | "implementation";

export interface DesignSessionLink {
  id: string;
  tabId: string;
  sessionId?: string;
  platform: "claude" | "codex" | string;
  role: DesignSessionRole;
  createdAt: string;
  checkpointId?: string;
  label?: string;
}

export interface DesignWorkspaceMeta {
  recordSequence: number;
  statusVersion: number;
  incarnation: string;
  createdAt: string;
  modifiedAt: string;
  frames: Record<string, DesignFrameMeta>;
  history: DesignHistoryStatus;
  export?: DesignExportAssociation;
  pendingExport?: DesignPendingExport;
  sessions: DesignSessionLink[];
  migratedFromLegacy?: boolean;
}

export interface DesignSnapshotEnvelope {
  kind: "snapshot";
  responseVersion: number;
  generation: string;
  canvas: DesignCanvas;
  workspace: DesignWorkspaceMeta;
}

export interface DesignTombstone {
  kind: "deleted";
  responseVersion: number;
  generation: string;
  canvasId: string;
  name: string;
  revision: number;
  deletedAt: string;
  restorable: boolean;
  statusVersion: number;
}

export interface DesignMissing {
  kind: "missing";
  responseVersion: number;
  generation: string;
  canvasId: string;
}

export interface DesignRecordProblem {
  kind: "record-problem";
  responseVersion: number;
  generation: string;
  canvasId: string;
  problem: "corrupt" | "unsupported-version";
  message: string;
  /** A legacy/backup copy exists that the user may explicitly recover. */
  backupAvailable: boolean;
}

export type DesignSnapshotResult =
  | DesignSnapshotEnvelope
  | DesignTombstone
  | DesignMissing
  | DesignRecordProblem;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface DesignFrameInput {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  html: string;
}

export type DesignFrameGeometryPatch = Partial<
  Pick<DesignFrame, "name" | "x" | "y" | "width" | "height">
>;

/** Inner operations permitted inside a transactional batch. */
export type DesignBatchableInput =
  | { kind: "create_frame"; frame: DesignFrameInput }
  | { kind: "update_frame"; frameId: string; patch: DesignFrameGeometryPatch }
  | { kind: "replace_frame_html"; frameId: string; html: string }
  | {
      kind: "set_element_styles";
      frameId: string;
      selector: string;
      styles: Record<string, string | null>;
    }
  | { kind: "delete_frame"; frameId: string }
  | { kind: "rename_canvas"; name: string };

export type DesignOperationInput =
  | { kind: "create_canvas"; name: string; document?: string }
  | { kind: "rename_canvas"; name: string }
  | { kind: "duplicate_canvas"; name?: string }
  | { kind: "delete_canvas" }
  | { kind: "restore_canvas" }
  | { kind: "create_frame"; frame: DesignFrameInput }
  | { kind: "update_frame"; frameId: string; patch: DesignFrameGeometryPatch }
  | { kind: "replace_frame_html"; frameId: string; html: string }
  | { kind: "append_frame_html"; frameId: string; html: string }
  | {
      kind: "set_element_styles";
      frameId: string;
      selector: string;
      styles: Record<string, string | null>;
    }
  | { kind: "replace_element_html"; frameId: string; selector: string; html: string }
  | {
      kind: "move_element";
      frameId: string;
      selector: string;
      parentSelector: string;
      beforeSelector?: string;
    }
  | { kind: "duplicate_frame"; frameId: string; name?: string; x?: number; y?: number }
  | { kind: "delete_frame"; frameId: string }
  | { kind: "undo"; scope?: "own" | "any" }
  | { kind: "redo"; scope?: "own" | "any" }
  | { kind: "restore_checkpoint"; entryId: string; side: "before" | "after" }
  | { kind: "batch"; operations: DesignBatchableInput[] };

export type DesignOperationKind = DesignOperationInput["kind"];

export interface DesignPreconditions {
  canvasRevision?: number;
  frameRevision?: number;
  structureId?: string;
  /** Required for restore: the tombstone's revision. */
  tombstoneRevision?: number;
}

export interface DesignOperationDescriptor {
  canvasId?: string;
  input: DesignOperationInput;
  preconditions: DesignPreconditions;
  /** Same-client committed predecessor that may substitute its result revision. */
  predecessor?: string;
  gestureId?: string;
  clientId?: string;
  /** Caller correlation id; repeated prepare with the same id and digest is idempotent. */
  correlationId?: string;
}

export type DesignOperationState =
  | "prepared"
  | "executing"
  | "committed"
  | "no-op"
  | "rejected"
  | "canceled"
  | "interrupted"
  | "expired"
  | "unknown";

export const DESIGN_TERMINAL_STATES: readonly DesignOperationState[] = [
  "committed",
  "no-op",
  "rejected",
  "canceled",
  "interrupted",
  "expired",
];

export interface DesignOperationResult {
  canvasRevision: number;
  frames: Array<{
    frameId: string;
    revision: number;
    removed?: boolean;
    identity?: DesignFrameIdentity;
  }>;
  createdFrameId?: string;
  createdCanvasId?: string;
  historyEntryId?: string;
  /** Batch per-operation outcomes (bounded). */
  outcomes?: Array<{ kind: string; changed: boolean; frameId?: string }>;
  /** Style operations report accepted/unchanged properties by name. */
  unchangedProperties?: string[];
  validation?: Array<{ frameId: string; state: DesignValidationState; warnings: number }>;
}

export interface DesignOperationStatus {
  token: string;
  canvasId: string;
  kind: DesignOperationKind;
  state: DesignOperationState;
  actor: DesignActor;
  base: DesignPreconditions;
  result?: DesignOperationResult;
  failure?: DesignFailure;
  gestureId?: string;
  correlationId?: string;
  /** Submitting client, when declared; proves same-client predecessor chains. */
  clientId?: string;
  preparedAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface DesignPrepareResult {
  token: string;
  canvasId: string;
  state: "prepared";
  expiresAt: string;
}

export type DesignCommandResult<T> = { ok: true; value: T } | { ok: false; failure: DesignFailure };

// ---------------------------------------------------------------------------
// Incremental synchronization
// ---------------------------------------------------------------------------

export type DesignFrameChangeField = "name" | "geometry" | "viewport" | "content" | "structure";

export interface DesignChangeDescriptor {
  revision: number;
  frames: Array<{ id: string; fields: DesignFrameChangeField[]; created?: true; removed?: true }>;
  canvasFields: Array<"name" | "order">;
}

export interface DesignFramePatch {
  id: string;
  revision: number;
  identity: DesignFrameIdentity;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Present only when content identity changed or the frame is new. */
  html?: string;
  meta?: DesignFrameMeta;
}

export interface DesignSyncUnchanged {
  kind: "unchanged";
  responseVersion: number;
  generation: string;
  revision: number;
  statusVersion: number;
}

export interface DesignSyncDelta {
  kind: "delta";
  responseVersion: number;
  generation: string;
  baseRevision: number;
  revision: number;
  statusVersion: number;
  canvas?: { name?: string; order?: string[] };
  added: DesignFramePatch[];
  patched: DesignFramePatch[];
  removed: string[];
  /** Workspace metadata sans frames; always replaces the client copy. */
  workspace: Omit<DesignWorkspaceMeta, "frames">;
  /** Complete frame metadata, present when the client's status version was stale. */
  frameMeta?: Record<string, DesignFrameMeta>;
}

export interface DesignSyncStatus {
  kind: "status";
  responseVersion: number;
  generation: string;
  revision: number;
  statusVersion: number;
  workspace: DesignWorkspaceMeta;
}

export interface DesignSyncReset {
  kind: "reset";
  responseVersion: number;
  generation: string;
  revision: number;
  reason:
    | "generation"
    | "future-cursor"
    | "expired-range"
    | "too-large"
    | "unsupported"
    | "restored";
}

export type DesignSyncResult =
  | DesignSyncUnchanged
  | DesignSyncDelta
  | DesignSyncStatus
  | DesignSyncReset
  | DesignSnapshotEnvelope
  | DesignTombstone
  | DesignMissing
  | DesignRecordProblem;

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface DesignHistoryEntrySummary {
  id: string;
  kind: DesignOperationKind | "migration";
  label: string;
  actor: DesignActor;
  createdAt: string;
  canvasRevisionBefore: number;
  canvasRevisionAfter: number;
  frames: Array<{
    frameId: string;
    name: string;
    before?: number;
    after?: number;
  }>;
  undone: boolean;
  undoOf?: string;
  gestureId?: string;
  protected: boolean;
  bytes: number;
}

export interface DesignHistoryPage {
  entries: DesignHistoryEntrySummary[];
  total: number;
  nextOffset?: number;
  bytes: number;
  limits: { entries: number; bytes: number };
}

export interface DesignCheckpointPreview {
  entryId: string;
  side: "before" | "after";
  frames: Array<{ frameId: string; frame: DesignFrame | null }>;
  canvasName?: string;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface DesignExportTarget {
  relativePath: string;
  exists: boolean;
  /** Present when the existing file parses as a design document. */
  canvasId?: string;
  sameCanvas: boolean;
  fingerprint?: string;
  readable: boolean;
  needsReplaceConfirmation: boolean;
  reason?: "other-canvas" | "not-design" | "unreadable" | "changed-since-export" | "same-canvas";
}

export interface DesignExportPreview {
  suggestedPath: string;
  association?: DesignExportAssociation;
  target: DesignExportTarget;
  revision: number;
}

export interface DesignExportReceipt {
  token: string;
  relativePath: string;
  revision: number;
  digest: string;
  replaced: boolean;
  exportedAt: string;
  currentRevision: number;
}

// ---------------------------------------------------------------------------
// Renderer readiness and library
// ---------------------------------------------------------------------------

export type DesignRendererState =
  | "unknown"
  | "missing-executable"
  | "launch-failed"
  | "saturated"
  | "ready"
  | "running"
  | "recovering"
  | "stopping";

export interface DesignRendererHealth {
  state: DesignRendererState;
  ready: boolean;
  message: string;
  checkedAt?: string;
  queued: number;
  running: number;
  generation: number;
  executableConfigured: boolean;
  /** Legacy field retained for old clients. */
  error?: string;
}

export interface DesignReadiness {
  capabilities: DesignCapabilities;
  storage: { available: boolean; canvases: number; limit: number; message?: string };
  renderer: DesignRendererHealth;
}

export interface DesignLibraryEntry {
  id: string;
  name: string;
  revision: number;
  modifiedAt: string;
  createdAt: string;
  frameCount: number;
  state: "live" | "deleted" | "problem";
  deletedAt?: string;
  export?: { relativePath: string; revision: number; outdated: boolean };
  validation: { invalid: number; unvalidated: number };
  problem?: DesignRecordProblem["problem"];
}

export interface DesignLibraryPage {
  entries: DesignLibraryEntry[];
  total: number;
  nextOffset?: number;
  quota: {
    live: number;
    liveLimit: number;
    deleted: number;
    deletedLimit: number;
    deletedBytes: number;
    deletedBytesLimit: number;
  };
}

export interface DesignLibraryQuery {
  search?: string;
  filter?: "live" | "deleted" | "all";
  sort?: "modified" | "name";
  offset?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Agent context
// ---------------------------------------------------------------------------

export interface DesignContextReference {
  version: 1;
  canvasId: string;
  canvasName: string;
  environmentId: string;
  frameId?: string;
  frameName?: string;
  canvasRevision: number;
  frameRevision?: number;
  structureId?: string;
  element?: { selector: string; key?: string; tag: string; label: string };
  scope: "discuss" | "revise" | "implement";
  checkpointId?: string;
}
