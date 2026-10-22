/**
 * Client-facing change resources: immutable diff identities, backend-prepared
 * projections and the request/response shapes of the `changes.*` commands.
 *
 * A {@link ChangeProjection} selects one measurement for one scoped resource
 * and carries every presentation decision the backend made about it — badge
 * visibility, count quality, provenance, available actions. Clients format
 * and lay out these values; they never count lines, choose between evidence
 * sources, sum pages or decide that a missing count is zero.
 *
 * A {@link DiffIdentity} names exactly what a body compares. A historical tool
 * or turn link always resolves through its identity; "view current file" is a
 * separate explicit action.
 *
 * Portable: types and bounded validation only.
 */

import type { ExecutionOccurrence, ToolKind, ToolPhase } from "./change-evidence.js";
import {
  lineCountIssues,
  MEASUREMENT_SCOPES,
  type ChangeMeasurement,
  type LineCount,
  type MeasurementScope,
} from "./change-measurements.js";
import { isPlainRecord } from "./field-validation.js";

export const CHANGE_PROJECTION_SCHEMA_VERSION = 1 as const;

/** SSE/IPC event carrying a {@link ChangeProjectionEvent}. */
export const CHANGE_PROJECTION_CHANGED_EVENT = "change-projection-changed";

/** Protocol capability a backend advertises once the `changes.*` API exists. */
export const CHANGE_TRACKING_PROTOCOL_CAPABILITY = "change-tracking-v1";

/** `changes_get_capabilities`: what a client may offer against this backend. */
export interface ChangeTrackingCapabilities {
  capability: typeof CHANGE_TRACKING_PROTOCOL_CAPABILITY;
  policyVersion: string;
  history: boolean;
  restore: boolean;
  gitScopes: boolean;
  operationVolume: boolean;
  strictCheckpoints: boolean;
}

// ---------------------------------------------------------------------------
// Diff identity
// ---------------------------------------------------------------------------

export interface DiffIdentityBase {
  id: string;
  worktreeId: string;
  worktreeIncarnation: string;
  scope: MeasurementScope;
  measurementId: string;
  algorithmPolicyId: string;
  representationPolicyId: string;
  rendererPolicyId: string;
  whitespacePolicy: "preserve" | "ignore-for-view";
}

export type DiffFileSide =
  | { state: "present"; snapshotId: string; pathId: string; blobId: string }
  /** Absence established at the named boundary. */
  | { state: "absent" }
  | { state: "unknown"; reason: string };

export type DiffIdentity = DiffIdentityBase &
  (
    | { kind: "comparison"; beforeSnapshotId: string; afterSnapshotId: string }
    | {
        kind: "file";
        before: DiffFileSide;
        after: DiffFileSide;
        basePathDisplay: string | null;
        targetPathDisplay: string | null;
      }
    | {
        kind: "payload";
        evidenceId: string;
        evidenceRevision: number;
        pathDisplays: readonly { before: string | null; after: string | null }[];
      }
  );

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export type ChangeFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "mode-changed"
  | "type-changed"
  | "unknown";

export type ChangeFileKind = "text" | "binary" | "symlink" | "gitlink" | "unknown";

export type BodyAvailability = "available" | "pending" | "expired" | "unavailable" | "not-retained";

export interface ChangeFileRow {
  /** Stable identity within the projection revision. */
  rowId: string;
  /** Opaque, reversible path identity (escaped for non-UTF-8 bytes). */
  pathId: string;
  oldPathDisplay: string | null;
  newPathDisplay: string | null;
  status: ChangeFileStatus;
  fileKind: ChangeFileKind;
  additions: LineCount;
  deletions: LineCount;
  bodyAvailability: BodyAvailability;
  /** Reason key when the body is not available or counts are not exact. */
  reasonKey: string | null;
  detail: { diffIdentityId: string } | null;
}

export type ChangeActionKind =
  | "open-historical-diff"
  | "open-current-diff"
  | "refresh"
  | "restore"
  | "copy-handoff";

export interface ChangeAction {
  kind: ChangeActionKind;
  /** Backend-issued token; the backend revalidates on execution. */
  targetToken: string;
  enabled: boolean;
  reasonKey: string | null;
}

export type ChangeProjectionState =
  | "loading"
  | "ready"
  | "partial"
  | "stale"
  | "unavailable"
  | "deleted";

export interface ChangeProjectionFreshness {
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastContentChangeObservedAt: string | null;
  observedAt: string | null;
  requiredObservationEpoch: number | null;
  checkedObservationEpoch: number | null;
}

export interface ChangeProjection {
  schemaVersion: typeof CHANGE_PROJECTION_SCHEMA_VERSION;
  resourceKey: string;
  ownerGeneration: string;
  revision: number;
  measurementId: string | null;
  /** Backend-selected presentation priority over the independent fields. */
  state: ChangeProjectionState;
  availability: "ready" | "pending" | "unavailable" | "deleted";
  observationState: "fresh" | "stale" | "degraded" | "unknown";
  coverageState: "complete" | "partial" | "unknown";
  labelKey: string;
  labelArgs: Record<string, string | number>;
  /** Null when presence is unknown, never false by default. */
  hasFileChanges: boolean | null;
  hasTextChanges: boolean | null;
  badge: { visible: boolean; mode: "counts" | "files-only" | "unknown" | "none" };
  counters: { additions: LineCount; deletions: LineCount; changedFiles: number | null };
  provenanceLabelKey: string;
  reasonKeys: string[];
  freshness: ChangeProjectionFreshness;
  detail: { diffIdentityId: string } | null;
  filePage: {
    snapshotToken: string;
    rows: ChangeFileRow[];
    nextCursor: string | null;
    totalRows: number | null;
  } | null;
  actions: ChangeAction[];
}

/**
 * A tool's change presentation. Payload, effect and observation are separate
 * resources with their own projections; the backend orders them and chooses
 * prominence. Clients never merge their counters.
 */
export interface CanonicalToolPresentation {
  schemaVersion: 1;
  operationId: string;
  attemptId: string;
  /** Monotonic presentation revision, not source order. */
  revision: number;
  toolKind: ToolKind;
  lifecycle: { phase: ToolPhase; executionOccurrence: ExecutionOccurrence };
  changes: readonly {
    role: "payload" | "effect" | "observation";
    resourceKey: string;
    prominence: "primary" | "secondary";
  }[];
}

/** Turn presentation: turn-net and provider-turn-diff stay separate resources. */
export interface CanonicalTurnPresentation {
  schemaVersion: 1;
  turnId: string;
  revision: number;
  changes: readonly {
    role: "turn-net" | "provider-turn-diff" | "operation-volume";
    resourceKey: string;
    prominence: "primary" | "secondary";
  }[];
}

// ---------------------------------------------------------------------------
// Resource keys
// ---------------------------------------------------------------------------

export type ChangeSelector = "live" | "final" | "pinned";

/**
 * Stable logical resource: scope, logical owner and selector. The backend
 * resolves every component into authorized worktree and ledger records; a
 * client never derives one from a path.
 */
export interface ChangeResourceKeyParts {
  scope: MeasurementScope;
  ownerKind: "environment" | "thread" | "segment" | "turn" | "operation" | "attempt";
  ownerId: string;
  selector: ChangeSelector;
  /** Optional role qualifier (payload/effect/observation) for tool resources. */
  role?: string;
}

const KEY_PART = /^[A-Za-z0-9._:@+=-]{1,256}$/;

export function changeResourceKey(parts: ChangeResourceKeyParts): string {
  const role = parts.role ? `/${parts.role}` : "";
  return `${parts.scope}/${parts.ownerKind}/${encodeURIComponent(parts.ownerId)}/${parts.selector}${role}`;
}

export function parseChangeResourceKey(key: string): ChangeResourceKeyParts | null {
  if (typeof key !== "string" || key.length > 1024) return null;
  const segments = key.split("/");
  if (segments.length < 4 || segments.length > 5) return null;
  const [scope, ownerKind, encodedOwner, selector, role] = segments;
  if (!(MEASUREMENT_SCOPES as readonly string[]).includes(scope!)) return null;
  if (!["environment", "thread", "segment", "turn", "operation", "attempt"].includes(ownerKind!)) {
    return null;
  }
  if (!["live", "final", "pinned"].includes(selector!)) return null;
  let ownerId: string;
  try {
    ownerId = decodeURIComponent(encodedOwner!);
  } catch {
    return null;
  }
  if (!ownerId || ownerId.length > 256) return null;
  if (role !== undefined && !KEY_PART.test(role)) return null;
  return {
    scope: scope as MeasurementScope,
    ownerKind: ownerKind as ChangeResourceKeyParts["ownerKind"],
    ownerId,
    selector: selector as ChangeSelector,
    ...(role !== undefined ? { role } : {}),
  };
}

export function environmentChangeResourceKey(environmentId: string): string {
  return changeResourceKey({
    scope: "environment-net",
    ownerKind: "environment",
    ownerId: environmentId,
    selector: "live",
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const CHANGE_ERROR_CODES = [
  "unsupported-capability",
  "unavailable-before",
  "capture-timeout",
  "unstable-capture",
  "body-expired",
  "stale-revision",
  "stale-cursor",
  "owner-replaced",
  "resource-deleted",
  "not-found",
  "invalid-request",
  "precondition-failed",
  "token-expired",
] as const;
export type ChangeErrorCode = (typeof CHANGE_ERROR_CODES)[number];

export interface ChangeError {
  code: ChangeErrorCode;
  reasonKey: string;
}

export type ChangeViewResult =
  | { kind: "projection"; projection: ChangeProjection }
  | { kind: "unchanged"; ownerGeneration: string; revision: number }
  | { kind: "reset"; projection: ChangeProjection }
  | { kind: "deleted"; resourceKey: string }
  | { kind: "error"; error: ChangeError };

export interface ChangesGetViewRequest {
  resourceKey: string;
  knownGeneration?: string;
  knownRevision?: number;
  pageSize?: number;
}

export interface ChangesGetFilesRequest {
  resourceKey: string;
  snapshotToken: string;
  cursor?: string | null;
  pageSize?: number;
}

export type ChangesGetFilesResult =
  | {
      kind: "page";
      snapshotToken: string;
      rows: ChangeFileRow[];
      nextCursor: string | null;
      totalRows: number | null;
      deliveredRows: number;
    }
  | { kind: "error"; error: ChangeError };

export interface ChangeHistoryEntry {
  turnId: string;
  segmentId: string;
  lifecycle: string;
  startedAt: string | null;
  finishedAt: string | null;
  turnResourceKey: string;
  measurementId: string | null;
  presentation: CanonicalTurnPresentation;
}

export interface ChangesGetHistoryRequest {
  threadId: string;
  cursor?: string | null;
  pageSize?: number;
}

export type ChangesGetHistoryResult =
  | { kind: "page"; entries: ChangeHistoryEntry[]; nextCursor: string | null }
  | { kind: "error"; error: ChangeError };

export interface ChangesResolveLiveDetailRequest {
  resourceKey: string;
  /** The projection revision the row came from; omitted for an explicit current-file action. */
  revision?: number;
  rowId?: string;
  pathId?: string;
  /** Plain worktree-relative or absolute path; the backend resolves it. */
  path?: string;
}

export type ChangesResolveLiveDetailResult =
  | { kind: "identity"; identity: DiffIdentity }
  | { kind: "error"; error: ChangeError };

export interface DiffDisplayOptions {
  whitespace?: "preserve" | "ignore-for-view";
  contextLines?: number;
}

export interface ChangesGetDiffRequest {
  diffIdentityId: string;
  cursor?: string | null;
  display?: DiffDisplayOptions;
}

export interface ChangeDiffLine {
  type: "context" | "add" | "remove" | "no-newline";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface ChangeDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ChangeDiffLine[];
}

export interface ChangeDiffFileBody {
  pathId: string;
  oldPathDisplay: string | null;
  newPathDisplay: string | null;
  status: ChangeFileStatus;
  fileKind: ChangeFileKind;
  bodyAvailability: BodyAvailability;
  reasonKey: string | null;
  hunks: ChangeDiffHunk[];
  truncated: boolean;
}

export type ChangesGetDiffResult =
  | {
      kind: "body";
      identity: DiffIdentity;
      measurement: ChangeMeasurement | null;
      files: ChangeDiffFileBody[];
      nextCursor: string | null;
      /** Display identity: differs from `identity.id` for whitespace views. */
      viewIdentityId: string;
      /** Backend provenance label of the measurement, when one is retained. */
      provenanceLabelKey?: string | null;
    }
  | { kind: "error"; error: ChangeError; identityId: string };

export interface ChangesRefreshRequest {
  resourceKey: string;
  requiredBaselineVersion?: string | null;
}

export type ChangesRefreshResult =
  | {
      kind: "settled";
      token: string;
      requiredObservationEpoch: number;
      projection: ChangeProjection | null;
    }
  | { kind: "pending"; token: string; requiredObservationEpoch: number }
  | { kind: "error"; error: ChangeError; token: string | null };

export interface ChangesGetHandoffRequest {
  measurementIds: readonly string[];
  maxCharacters?: number;
}

export type ChangesGetHandoffResult =
  | { kind: "handoff"; text: string; measurementIds: string[]; truncated: boolean }
  | { kind: "error"; error: ChangeError };

export interface ChangesPrepareRestoreRequest {
  measurementId: string;
  pathIds?: readonly string[];
  expectedRevision?: number;
}

export interface RestorePreviewFile {
  pathId: string;
  pathDisplay: string;
  action: "write" | "delete" | "skip";
  reasonKey: string | null;
}

export type ChangesPrepareRestoreResult =
  | {
      kind: "preview";
      actionToken: string;
      expiresAt: string;
      files: RestorePreviewFile[];
      residualRiskKeys: string[];
    }
  | { kind: "disabled"; reasonKey: string }
  | { kind: "error"; error: ChangeError };

export interface ChangesApplyRestoreRequest {
  actionToken: string;
  idempotencyKey: string;
}

export type ChangesApplyRestoreResult =
  | {
      kind: "applied";
      operationId: string;
      outcome: "complete" | "partial";
      completedPathIds: string[];
      failedPathIds: string[];
      resultMeasurementId: string | null;
    }
  | { kind: "error"; error: ChangeError };

/** Event payload for {@link CHANGE_PROJECTION_CHANGED_EVENT}. */
export type ChangeProjectionEvent =
  | { kind: "projection"; projection: ChangeProjection }
  | { kind: "deleted"; resourceKey: string; ownerGeneration: string; revision: number }
  | { kind: "reset"; resourceKey: string; ownerGeneration: string }
  /**
   * File contents may have changed even if every count stayed equal. Open live
   * bodies of these paths (all paths when `pathIds` is null) must request a
   * new immutable identity.
   */
  | {
      kind: "content-invalidated";
      resourceKey: string;
      ownerGeneration: string;
      contentGeneration: number;
      pathIds: string[] | null;
    };

// ---------------------------------------------------------------------------
// Validation (clients validate before rendering)
// ---------------------------------------------------------------------------

function oneOf(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

function nullableCount(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isFileRow(value: unknown): value is ChangeFileRow {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.rowId === "string" &&
    typeof value.pathId === "string" &&
    (value.oldPathDisplay === null || typeof value.oldPathDisplay === "string") &&
    (value.newPathDisplay === null || typeof value.newPathDisplay === "string") &&
    oneOf(
      [
        "added",
        "modified",
        "deleted",
        "renamed",
        "copied",
        "mode-changed",
        "type-changed",
        "unknown",
      ],
      value.status,
    ) &&
    oneOf(["text", "binary", "symlink", "gitlink", "unknown"], value.fileKind) &&
    lineCountIssues(value.additions, "a").length === 0 &&
    lineCountIssues(value.deletions, "d").length === 0 &&
    oneOf(
      ["available", "pending", "expired", "unavailable", "not-retained"],
      value.bodyAvailability,
    )
  );
}

export function isChangeProjection(value: unknown): value is ChangeProjection {
  if (!isPlainRecord(value)) return false;
  const p = value;
  if (p.schemaVersion !== CHANGE_PROJECTION_SCHEMA_VERSION) return false;
  if (typeof p.resourceKey !== "string" || typeof p.ownerGeneration !== "string") return false;
  if (!nullableCount(p.revision) || p.revision === null) return false;
  if (!oneOf(["loading", "ready", "partial", "stale", "unavailable", "deleted"], p.state)) {
    return false;
  }
  if (!oneOf(["ready", "pending", "unavailable", "deleted"], p.availability)) return false;
  if (!oneOf(["fresh", "stale", "degraded", "unknown"], p.observationState)) return false;
  if (!oneOf(["complete", "partial", "unknown"], p.coverageState)) return false;
  if (!isPlainRecord(p.badge) || !oneOf(["counts", "files-only", "unknown", "none"], p.badge.mode))
    return false;
  if (!isPlainRecord(p.counters)) return false;
  if (lineCountIssues(p.counters.additions, "a").length > 0) return false;
  if (lineCountIssues(p.counters.deletions, "d").length > 0) return false;
  if (!nullableCount(p.counters.changedFiles)) return false;
  if (p.filePage !== null) {
    if (!isPlainRecord(p.filePage) || !Array.isArray(p.filePage.rows)) return false;
    if (!p.filePage.rows.every(isFileRow)) return false;
  }
  return Array.isArray(p.actions) && Array.isArray(p.reasonKeys);
}

export function isChangeProjectionEvent(value: unknown): value is ChangeProjectionEvent {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "projection") return isChangeProjection(value.projection);
  if (value.kind === "deleted") {
    return typeof value.resourceKey === "string" && typeof value.ownerGeneration === "string";
  }
  if (value.kind === "reset") {
    return typeof value.resourceKey === "string" && typeof value.ownerGeneration === "string";
  }
  if (value.kind === "content-invalidated") {
    return (
      typeof value.resourceKey === "string" &&
      typeof value.ownerGeneration === "string" &&
      typeof value.contentGeneration === "number" &&
      (value.pathIds === null ||
        (Array.isArray(value.pathIds) && value.pathIds.every((id) => typeof id === "string")))
    );
  }
  return false;
}
