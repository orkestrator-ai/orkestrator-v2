/**
 * Canonical provider evidence about file changes.
 *
 * Every provider adapter (bridge or backend) translates its native tool,
 * turn and patch events into {@link ProviderEvidenceFrame} at the lowest
 * boundary that understands them. Shared backend services see only this
 * envelope: provider names never select a count algorithm above it.
 *
 * A frame is evidence, not a measurement. A tool's success status, the patch
 * it supplied and the workspace state observed around it are separate facts;
 * this contract keeps all three. Absent old text is `unknown`, never an empty
 * before-image, and an in-progress edit is never folded into a completed one.
 *
 * Portable: types plus bounded validation only. See
 * `docs/architecture/change-tracking.md`.
 */

import { isPlainRecord } from "./field-validation.js";

export const PROVIDER_EVIDENCE_SCHEMA_VERSION = 1 as const;

export const TOOL_KINDS = [
  "shell",
  "file-edit",
  "file-write",
  "file-delete",
  "file-move",
  "notebook-edit",
  "read",
  "other",
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const TOOL_PHASES = [
  "proposed",
  "awaiting-approval",
  "running",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "unknown",
] as const;
export type ToolPhase = (typeof TOOL_PHASES)[number];

/** Terminal phases never regress to running when an older update arrives. */
export const TERMINAL_TOOL_PHASES: ReadonlySet<ToolPhase> = new Set([
  "succeeded",
  "failed",
  "denied",
  "cancelled",
]);

export const EXECUTION_OCCURRENCE_VALUES = [
  "not-started",
  "started",
  "did-not-run",
  "unknown",
] as const;
export type ExecutionOccurrence = (typeof EXECUTION_OCCURRENCE_VALUES)[number];

export type ProviderEffectClaim = "proposal" | "provider-reported" | "unknown";
export type WriterLiveness = "may-write" | "quiescent" | "unknown";

/** Opaque reference to a body retained by the evidence store. */
export interface EvidenceBodyRef {
  /** Opaque backend resource id; never a filesystem path. */
  id: string;
  state: "pending" | "available" | "unavailable";
  retainedBytes: number;
  originalBytes?: number;
  /** False when only a prefix survived. */
  complete: boolean;
  unavailableReason?: string;
}

/** One side of a replacement. Absence must be established; otherwise unknown. */
export type FileSide =
  | { state: "present"; body: EvidenceBodyRef }
  | { state: "absent" }
  | { state: "unknown"; reason: string };

export type ProviderEvidence =
  | {
      kind: "patch";
      path?: string;
      previousPath?: string;
      body: EvidenceBodyRef;
      format: "git_unified" | "opaque";
      effectClaim: ProviderEffectClaim;
    }
  | {
      kind: "replacement";
      path: string;
      before: FileSide;
      after: FileSide;
      extent: "fragment" | "whole-file" | "notebook-cell" | "unknown";
      origin: "input" | "result";
      effectClaim: ProviderEffectClaim;
    }
  | {
      kind: "reported-counts";
      path?: string;
      additions: number | null;
      deletions: number | null;
      contentLines?: number | null;
      scope: "file" | "tool" | "turn";
      effectClaim: ProviderEffectClaim;
    }
  | {
      kind: "path-operation";
      path: string;
      previousPath?: string;
      operation: "add" | "modify" | "delete" | "rename" | "unknown";
      effectClaim: ProviderEffectClaim;
    };

export type ProviderEvidenceUpdate =
  | {
      kind: "replace";
      /** Stable semantic block within its source owner; survives replay. */
      evidenceKey: string;
      /** Opaque source/adapter version; equality only, never ordered. */
      revisionKey: string;
      /** Set only when the source establishes supersession. */
      replacesRevisionKey?: string;
      evidence: ProviderEvidence;
    }
  | {
      kind: "append";
      evidenceKey: string;
      revisionKey: string;
      targetBodyId: string;
      /** Stable across replay/retry. */
      chunkId: string;
      chunkIndex: number;
      /** UTF-8 byte offset, not a character position. */
      offsetBytes: number;
      chunk: EvidenceBodyRef;
      final: boolean;
    };

/** Ordered only within one declared scope and epoch. */
export interface SourceSequence {
  scopeId: string;
  epoch: string;
  /** Unsigned decimal string; compared numerically. */
  value: string;
}

export type EvidenceGapCoverage =
  | { kind: "frames"; frameIds: readonly string[] }
  | {
      kind: "source-sequence";
      scopeId: string;
      epoch: string;
      fromInclusive: string;
      toInclusive: string;
    }
  | { kind: "unknown-range"; bindingId: string; runtimeEpoch: string };

export type ProviderEvidenceEvent =
  | {
      kind: "tool";
      toolKind: ToolKind;
      phase: ToolPhase;
      executionOccurrence: ExecutionOccurrence;
      evidence: ProviderEvidenceUpdate[];
      backgroundTaskId?: string;
    }
  | {
      kind: "turn";
      phase: "proposed" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
      writerLiveness: WriterLiveness;
    }
  | {
      kind: "background-task";
      taskId: string;
      parentCallId?: string;
      phase: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
      executionOccurrence: ExecutionOccurrence;
      writerLiveness: WriterLiveness;
      evidence: ProviderEvidenceUpdate[];
    }
  | {
      kind: "turn-diff";
      evidence: ProviderEvidenceUpdate[];
      endpointMeaning: "provider-reported" | "unknown";
    }
  | { kind: "stream-gap"; gapId: string; coverage: EvidenceGapCoverage; reason: string };

export interface ProviderEvidenceSource {
  conversationId: string;
  turnId?: string;
  callId?: string;
  /** Only an established native relationship. */
  parentCallId?: string;
  parentConversationId?: string;
  subagentId?: string;
  itemId?: string;
  /** Only a documented native attempt identity. */
  attemptId?: string;
  /** Equality/reconciliation only; never lexically ordered. */
  nativeRevision?: string;
  mode: "live" | "history" | "reconciliation";
}

export interface ProviderEvidenceFrame {
  schemaVersion: typeof PROVIDER_EVIDENCE_SCHEMA_VERSION;
  /** Backend-issued runtime binding; resolves thread, run and worktree. */
  bindingId: string;
  /** Producer fence. A new epoch is not a new semantic operation. */
  runtimeEpoch: string;
  capabilityRevision: string;
  /** Stable across transport retry. */
  frameId: string;
  sourceSequence?: SourceSequence;
  /** Opaque replay position; equality only. */
  sourceCursor?: { scopeId: string; value: string };
  source: ProviderEvidenceSource;
  event: ProviderEvidenceEvent;
  raw?: EvidenceBodyRef;
}

/** Durable ingest outcome. An in-memory enqueue is never an acknowledgment. */
export type ProviderEvidenceAck =
  | {
      kind: "accepted";
      frameId: string;
      receiptId: string;
      retainedBodyIds: readonly string[];
    }
  | { kind: "gap-recorded"; gapId: string; coverage: EvidenceGapCoverage; reason: string };

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What one runtime binding can actually establish. Every unresolved fact is
 * `unknown`; `none`/`absent` mean confirmed absence. Historical evidence keeps
 * the revision it was captured under, so a later upgrade never strengthens an
 * old measurement.
 */
export interface ProviderChangeCapabilities {
  capabilityRevision: string;
  resolution: "resolved" | "partial" | "unknown";
  beforeTurn: "controlled-dispatch" | "observed-after-start" | "none" | "unknown";
  afterTurn: "settled-writers" | "terminal-observed" | "none" | "unknown";
  beforeTool: "awaited" | "observed-after-start" | "none" | "unknown";
  afterTool: "awaited" | "observed" | "none" | "unknown";
  historicalCallIdentity: "stable" | "partial" | "absent" | "unknown";
  fileEvidence: {
    resolution: "confirmed" | "unknown";
    kinds: readonly ("patch" | "replacement" | "whole-file" | "reported-counts")[];
  };
  turnDiff: "reported" | "absent" | "unknown";
  captureExecutor: "host-worker" | "container-worker" | "none" | "unknown";
  captureAvailability: "ready" | "offline" | "unavailable" | "unknown";
  backgroundCompletion: "observable" | "launch-only" | "unknown";
}

/** The capability record every adapter starts from: nothing is assumed. */
export function unknownCapabilities(capabilityRevision: string): ProviderChangeCapabilities {
  return {
    capabilityRevision,
    resolution: "unknown",
    beforeTurn: "unknown",
    afterTurn: "unknown",
    beforeTool: "unknown",
    afterTool: "unknown",
    historicalCallIdentity: "unknown",
    fileEvidence: { resolution: "unknown", kinds: [] },
    turnDiff: "unknown",
    captureExecutor: "unknown",
    captureAvailability: "unknown",
    backgroundCompletion: "unknown",
  };
}

// ---------------------------------------------------------------------------
// Bounded validation
// ---------------------------------------------------------------------------

/** Canonical frame metadata above this size is rejected; bodies go by reference. */
export const CANONICAL_FRAME_METADATA_MAX_BYTES = 256 * 1024;
export const MAX_EVIDENCE_UPDATES_PER_FRAME = 256;
export const MAX_EVIDENCE_ID_LENGTH = 512;
export const MAX_EVIDENCE_PATH_LENGTH = 4096;
export const MAX_GAP_FRAME_IDS = 1024;

export interface EvidenceValidationIssue {
  path: string;
  message: string;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_EVIDENCE_ID_LENGTH;
}

function isPathValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EVIDENCE_PATH_LENGTH &&
    !value.includes("\0")
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUnsignedDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,39})$/.test(value);
}

/** Numeric comparison of two unsigned decimal strings. */
export function compareUnsignedDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function bodyRefIssues(value: unknown, path: string): EvidenceValidationIssue[] {
  if (!isPlainRecord(value)) return [{ path, message: "expected a body reference" }];
  const issues: EvidenceValidationIssue[] = [];
  if (!isId(value.id)) issues.push({ path: `${path}.id`, message: "expected an opaque id" });
  if (!oneOf(["pending", "available", "unavailable"] as const, value.state)) {
    issues.push({ path: `${path}.state`, message: "unknown body state" });
  }
  if (!isCount(value.retainedBytes)) {
    issues.push({ path: `${path}.retainedBytes`, message: "expected a byte count" });
  }
  if (value.originalBytes !== undefined && !isCount(value.originalBytes)) {
    issues.push({ path: `${path}.originalBytes`, message: "expected a byte count" });
  }
  if (typeof value.complete !== "boolean") {
    issues.push({ path: `${path}.complete`, message: "expected a boolean" });
  }
  if (value.state === "unavailable" && typeof value.unavailableReason !== "string") {
    issues.push({ path: `${path}.unavailableReason`, message: "unavailable needs a reason" });
  }
  return issues;
}

function sideIssues(value: unknown, path: string): EvidenceValidationIssue[] {
  if (!isPlainRecord(value)) return [{ path, message: "expected a file side" }];
  if (value.state === "absent") return [];
  if (value.state === "unknown") {
    return typeof value.reason === "string" && value.reason.length > 0
      ? []
      : [{ path: `${path}.reason`, message: "unknown sides need a reason" }];
  }
  if (value.state === "present") return bodyRefIssues(value.body, `${path}.body`);
  return [{ path: `${path}.state`, message: "unknown side state" }];
}

const CLAIMS = ["proposal", "provider-reported", "unknown"] as const;

function evidenceIssues(value: unknown, path: string): EvidenceValidationIssue[] {
  if (!isPlainRecord(value)) return [{ path, message: "expected evidence" }];
  const issues: EvidenceValidationIssue[] = [];
  if (!oneOf(CLAIMS, value.effectClaim)) {
    issues.push({ path: `${path}.effectClaim`, message: "unknown effect claim" });
  }
  const optionalPath = (key: string) => {
    if (value[key] !== undefined && !isPathValue(value[key])) {
      issues.push({ path: `${path}.${key}`, message: "invalid path" });
    }
  };
  switch (value.kind) {
    case "patch":
      optionalPath("path");
      optionalPath("previousPath");
      issues.push(...bodyRefIssues(value.body, `${path}.body`));
      if (!oneOf(["git_unified", "opaque"] as const, value.format)) {
        issues.push({ path: `${path}.format`, message: "unknown patch format" });
      }
      break;
    case "replacement":
      if (!isPathValue(value.path)) issues.push({ path: `${path}.path`, message: "invalid path" });
      issues.push(...sideIssues(value.before, `${path}.before`));
      issues.push(...sideIssues(value.after, `${path}.after`));
      if (!oneOf(["fragment", "whole-file", "notebook-cell", "unknown"] as const, value.extent)) {
        issues.push({ path: `${path}.extent`, message: "unknown extent" });
      }
      if (!oneOf(["input", "result"] as const, value.origin)) {
        issues.push({ path: `${path}.origin`, message: "unknown origin" });
      }
      break;
    case "reported-counts":
      optionalPath("path");
      for (const key of ["additions", "deletions"] as const) {
        if (value[key] !== null && !isCount(value[key])) {
          issues.push({ path: `${path}.${key}`, message: "expected a count or null" });
        }
      }
      if (
        value.contentLines !== undefined &&
        value.contentLines !== null &&
        !isCount(value.contentLines)
      ) {
        issues.push({ path: `${path}.contentLines`, message: "expected a count or null" });
      }
      if (!oneOf(["file", "tool", "turn"] as const, value.scope)) {
        issues.push({ path: `${path}.scope`, message: "unknown count scope" });
      }
      break;
    case "path-operation":
      if (!isPathValue(value.path)) issues.push({ path: `${path}.path`, message: "invalid path" });
      optionalPath("previousPath");
      if (!oneOf(["add", "modify", "delete", "rename", "unknown"] as const, value.operation)) {
        issues.push({ path: `${path}.operation`, message: "unknown operation" });
      }
      break;
    default:
      issues.push({ path: `${path}.kind`, message: "unknown evidence kind" });
  }
  return issues;
}

function updateIssues(value: unknown, path: string): EvidenceValidationIssue[] {
  if (!isPlainRecord(value)) return [{ path, message: "expected an evidence update" }];
  const issues: EvidenceValidationIssue[] = [];
  if (!isId(value.evidenceKey)) issues.push({ path: `${path}.evidenceKey`, message: "required" });
  if (!isId(value.revisionKey)) issues.push({ path: `${path}.revisionKey`, message: "required" });
  if (value.kind === "replace") {
    if (value.replacesRevisionKey !== undefined && !isId(value.replacesRevisionKey)) {
      issues.push({ path: `${path}.replacesRevisionKey`, message: "invalid" });
    }
    issues.push(...evidenceIssues(value.evidence, `${path}.evidence`));
  } else if (value.kind === "append") {
    if (!isId(value.targetBodyId)) issues.push({ path: `${path}.targetBodyId`, message: "id" });
    if (!isId(value.chunkId)) issues.push({ path: `${path}.chunkId`, message: "id" });
    if (!isCount(value.chunkIndex)) issues.push({ path: `${path}.chunkIndex`, message: "count" });
    if (!isCount(value.offsetBytes)) issues.push({ path: `${path}.offsetBytes`, message: "count" });
    if (typeof value.final !== "boolean") issues.push({ path: `${path}.final`, message: "bool" });
    issues.push(...bodyRefIssues(value.chunk, `${path}.chunk`));
  } else {
    issues.push({ path: `${path}.kind`, message: "expected replace or append" });
  }
  return issues;
}

function updatesIssues(value: unknown, path: string): EvidenceValidationIssue[] {
  if (!Array.isArray(value)) return [{ path, message: "expected an array" }];
  if (value.length > MAX_EVIDENCE_UPDATES_PER_FRAME) {
    return [{ path, message: `at most ${MAX_EVIDENCE_UPDATES_PER_FRAME} updates per frame` }];
  }
  return value.flatMap((update, index) => updateIssues(update, `${path}[${index}]`));
}

function gapCoverageIssues(value: unknown, path: string): EvidenceValidationIssue[] {
  if (!isPlainRecord(value)) return [{ path, message: "expected gap coverage" }];
  switch (value.kind) {
    case "frames":
      return Array.isArray(value.frameIds) &&
        value.frameIds.length <= MAX_GAP_FRAME_IDS &&
        value.frameIds.every(isId)
        ? []
        : [{ path: `${path}.frameIds`, message: "expected bounded frame ids" }];
    case "source-sequence":
      return isId(value.scopeId) &&
        isId(value.epoch) &&
        isUnsignedDecimal(value.fromInclusive) &&
        isUnsignedDecimal(value.toInclusive) &&
        compareUnsignedDecimal(value.fromInclusive, value.toInclusive) <= 0
        ? []
        : [{ path, message: "invalid sequence range" }];
    case "unknown-range":
      return isId(value.bindingId) && isId(value.runtimeEpoch)
        ? []
        : [{ path, message: "invalid unknown range" }];
    default:
      return [{ path: `${path}.kind`, message: "unknown coverage kind" }];
  }
}

function eventIssues(value: unknown, path: string): EvidenceValidationIssue[] {
  if (!isPlainRecord(value)) return [{ path, message: "expected an event" }];
  const issues: EvidenceValidationIssue[] = [];
  switch (value.kind) {
    case "tool":
      if (!oneOf(TOOL_KINDS, value.toolKind)) issues.push({ path, message: "unknown tool kind" });
      if (!oneOf(TOOL_PHASES, value.phase)) issues.push({ path, message: "unknown phase" });
      if (!oneOf(EXECUTION_OCCURRENCE_VALUES, value.executionOccurrence)) {
        issues.push({ path, message: "unknown execution occurrence" });
      }
      if (value.backgroundTaskId !== undefined && !isId(value.backgroundTaskId)) {
        issues.push({ path: `${path}.backgroundTaskId`, message: "invalid id" });
      }
      issues.push(...updatesIssues(value.evidence, `${path}.evidence`));
      break;
    case "turn":
      if (
        !oneOf(
          ["proposed", "running", "succeeded", "failed", "cancelled", "unknown"] as const,
          value.phase,
        )
      ) {
        issues.push({ path, message: "unknown turn phase" });
      }
      if (!oneOf(["may-write", "quiescent", "unknown"] as const, value.writerLiveness)) {
        issues.push({ path, message: "unknown writer liveness" });
      }
      break;
    case "background-task":
      if (!isId(value.taskId)) issues.push({ path: `${path}.taskId`, message: "required" });
      if (
        !oneOf(["running", "succeeded", "failed", "cancelled", "unknown"] as const, value.phase)
      ) {
        issues.push({ path, message: "unknown task phase" });
      }
      if (!oneOf(EXECUTION_OCCURRENCE_VALUES, value.executionOccurrence)) {
        issues.push({ path, message: "unknown execution occurrence" });
      }
      if (!oneOf(["may-write", "quiescent", "unknown"] as const, value.writerLiveness)) {
        issues.push({ path, message: "unknown writer liveness" });
      }
      issues.push(...updatesIssues(value.evidence, `${path}.evidence`));
      break;
    case "turn-diff":
      if (!oneOf(["provider-reported", "unknown"] as const, value.endpointMeaning)) {
        issues.push({ path, message: "unknown endpoint meaning" });
      }
      issues.push(...updatesIssues(value.evidence, `${path}.evidence`));
      break;
    case "stream-gap":
      if (!isId(value.gapId)) issues.push({ path: `${path}.gapId`, message: "required" });
      if (typeof value.reason !== "string" || value.reason.length === 0) {
        issues.push({ path: `${path}.reason`, message: "required" });
      }
      issues.push(...gapCoverageIssues(value.coverage, `${path}.coverage`));
      break;
    default:
      issues.push({ path: `${path}.kind`, message: "unknown event kind" });
  }
  return issues;
}

/**
 * Validate one canonical frame, including the identities its event needs:
 * a tool frame names its call, turn frames name their turn. Missing identity
 * is reported so the caller records unassociated evidence instead of
 * inventing a call.
 */
export function providerEvidenceFrameIssues(value: unknown): EvidenceValidationIssue[] {
  if (!isPlainRecord(value)) return [{ path: "$", message: "expected an object" }];
  const issues: EvidenceValidationIssue[] = [];
  if (value.schemaVersion !== PROVIDER_EVIDENCE_SCHEMA_VERSION) {
    issues.push({ path: "schemaVersion", message: "unsupported" });
  }
  for (const key of ["bindingId", "runtimeEpoch", "capabilityRevision", "frameId"] as const) {
    if (!isId(value[key])) issues.push({ path: key, message: "required id" });
  }
  if (value.sourceSequence !== undefined) {
    const seq = value.sourceSequence;
    if (
      !isPlainRecord(seq) ||
      !isId(seq.scopeId) ||
      !isId(seq.epoch) ||
      !isUnsignedDecimal(seq.value)
    ) {
      issues.push({ path: "sourceSequence", message: "invalid source sequence" });
    }
  }
  if (value.sourceCursor !== undefined) {
    const cursor = value.sourceCursor;
    if (!isPlainRecord(cursor) || !isId(cursor.scopeId) || !isId(cursor.value)) {
      issues.push({ path: "sourceCursor", message: "invalid source cursor" });
    }
  }
  const source = value.source;
  if (!isPlainRecord(source)) issues.push({ path: "source", message: "required" });
  else {
    if (!isId(source.conversationId)) {
      issues.push({ path: "source.conversationId", message: "required" });
    }
    for (const key of [
      "turnId",
      "callId",
      "parentCallId",
      "parentConversationId",
      "subagentId",
      "itemId",
      "attemptId",
      "nativeRevision",
    ] as const) {
      if (source[key] !== undefined && !isId(source[key])) {
        issues.push({ path: `source.${key}`, message: "invalid id" });
      }
    }
    if (!oneOf(["live", "history", "reconciliation"] as const, source.mode)) {
      issues.push({ path: "source.mode", message: "unknown mode" });
    }
  }
  issues.push(...eventIssues(value.event, "event"));
  if (value.raw !== undefined) issues.push(...bodyRefIssues(value.raw, "raw"));
  if (issues.length > 0) return issues;

  const event = value.event as ProviderEvidenceEvent;
  const src = source as unknown as ProviderEvidenceSource;
  if (event.kind === "tool" && !src.callId && !src.itemId) {
    issues.push({ path: "source.callId", message: "tool frames need a native call identity" });
  }
  if ((event.kind === "turn" || event.kind === "turn-diff") && !src.turnId) {
    issues.push({ path: "source.turnId", message: "turn frames need a turn identity" });
  }
  if (JSON.stringify(value).length > CANONICAL_FRAME_METADATA_MAX_BYTES) {
    issues.push({ path: "$", message: "frame metadata exceeds its byte budget" });
  }
  return issues;
}

export function isProviderEvidenceFrame(value: unknown): value is ProviderEvidenceFrame {
  return providerEvidenceFrameIssues(value).length === 0;
}

export function isProviderEvidenceAck(value: unknown): value is ProviderEvidenceAck {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "accepted") {
    return (
      isId(value.frameId) &&
      isId(value.receiptId) &&
      Array.isArray(value.retainedBodyIds) &&
      value.retainedBodyIds.every(isId)
    );
  }
  if (value.kind === "gap-recorded") {
    return (
      isId(value.gapId) &&
      typeof value.reason === "string" &&
      gapCoverageIssues(value.coverage, "coverage").length === 0
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Capture-executor observation reports
// ---------------------------------------------------------------------------

/**
 * What a capture worker beside the worktree observed around one tool call.
 *
 * This is not provider evidence and not a measurement: the executor reports
 * the endpoints it read and how fresh they were. The backend owner decides
 * whether it is a tool effect or only an observation window, records overlap
 * known across every bridge sharing the worktree, and publishes the canonical
 * measurement. Paths are executor-relative and never establish worktree
 * identity on their own.
 */
export interface WorkspaceObservationFile {
  path: string;
  previousPath?: string;
  status: "A" | "D" | "M" | "R" | "T" | "unknown";
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface WorkspaceObservationReport {
  schemaVersion: typeof PROVIDER_EVIDENCE_SCHEMA_VERSION;
  reportId: string;
  bindingId: string;
  runtimeEpoch: string;
  capabilityRevision: string;
  source: { conversationId: string; turnId?: string; callId?: string; attemptId?: string };
  executor: "host-worker" | "container-worker";
  boundary: {
    before: "fresh-before" | "prior-observation" | "late-start" | "unknown";
    after: "after-terminal" | "running-observation" | "later-recovery" | "unknown";
  };
  /** Overlap the executor itself saw; the backend adds cross-bridge overlap. */
  overlap: "known-overlap" | "none-observed" | "unknown";
  consistency: "stable-observation" | "changed-during-capture" | "unknown";
  outcome:
    | {
        kind: "measured";
        files: WorkspaceObservationFile[];
        additions: number;
        deletions: number;
        changedFiles: number;
        filesTruncated: boolean;
        /** Files the executor could not measure (too large, unreadable). */
        omittedReasons: string[];
      }
    | { kind: "unavailable"; reason: string };
  observedAt: string;
}

export const MAX_OBSERVATION_FILES = 200;

export function workspaceObservationReportIssues(value: unknown): EvidenceValidationIssue[] {
  if (!isPlainRecord(value)) return [{ path: "$", message: "expected an object" }];
  const issues: EvidenceValidationIssue[] = [];
  if (value.schemaVersion !== PROVIDER_EVIDENCE_SCHEMA_VERSION) {
    issues.push({ path: "schemaVersion", message: "unsupported" });
  }
  for (const key of ["reportId", "bindingId", "runtimeEpoch", "capabilityRevision"] as const) {
    if (!isId(value[key])) issues.push({ path: key, message: "required id" });
  }
  const source = value.source;
  if (!isPlainRecord(source) || !isId(source.conversationId)) {
    issues.push({ path: "source", message: "conversation identity required" });
  }
  if (!oneOf(["host-worker", "container-worker"] as const, value.executor)) {
    issues.push({ path: "executor", message: "unknown executor" });
  }
  const boundary = value.boundary;
  if (
    !isPlainRecord(boundary) ||
    !oneOf(
      ["fresh-before", "prior-observation", "late-start", "unknown"] as const,
      boundary.before,
    ) ||
    !oneOf(
      ["after-terminal", "running-observation", "later-recovery", "unknown"] as const,
      boundary.after,
    )
  ) {
    issues.push({ path: "boundary", message: "invalid boundary" });
  }
  if (!oneOf(["known-overlap", "none-observed", "unknown"] as const, value.overlap)) {
    issues.push({ path: "overlap", message: "unknown overlap" });
  }
  if (
    !oneOf(["stable-observation", "changed-during-capture", "unknown"] as const, value.consistency)
  ) {
    issues.push({ path: "consistency", message: "unknown consistency" });
  }
  const outcome = value.outcome;
  if (!isPlainRecord(outcome)) issues.push({ path: "outcome", message: "required" });
  else if (outcome.kind === "unavailable") {
    if (typeof outcome.reason !== "string" || !outcome.reason) {
      issues.push({ path: "outcome.reason", message: "required" });
    }
  } else if (outcome.kind === "measured") {
    if (
      !isCount(outcome.additions) ||
      !isCount(outcome.deletions) ||
      !isCount(outcome.changedFiles)
    ) {
      issues.push({ path: "outcome", message: "invalid totals" });
    }
    if (
      !Array.isArray(outcome.files) ||
      outcome.files.length > MAX_OBSERVATION_FILES ||
      !outcome.files.every(
        (file) =>
          isPlainRecord(file) &&
          isPathValue(file.path) &&
          (file.previousPath === undefined || isPathValue(file.previousPath)) &&
          oneOf(["A", "D", "M", "R", "T", "unknown"] as const, file.status) &&
          (file.additions === null || isCount(file.additions)) &&
          (file.deletions === null || isCount(file.deletions)) &&
          typeof file.binary === "boolean",
      )
    ) {
      issues.push({ path: "outcome.files", message: "invalid files" });
    }
    if (typeof outcome.filesTruncated !== "boolean") {
      issues.push({ path: "outcome.filesTruncated", message: "required" });
    }
    if (
      !Array.isArray(outcome.omittedReasons) ||
      !outcome.omittedReasons.every((reason) => typeof reason === "string")
    ) {
      issues.push({ path: "outcome.omittedReasons", message: "required" });
    }
  } else {
    issues.push({ path: "outcome.kind", message: "unknown outcome" });
  }
  if (typeof value.observedAt !== "string")
    issues.push({ path: "observedAt", message: "required" });
  return issues;
}

/** One entry in a bridge's evidence spool. */
export type ChangeEvidenceEntry =
  | { seq: number; type: "frame"; frame: ProviderEvidenceFrame }
  | { seq: number; type: "observation"; report: WorkspaceObservationReport };

/** `GET /change-evidence` response. */
export interface ChangeEvidenceReadResponse {
  schemaVersion: typeof PROVIDER_EVIDENCE_SCHEMA_VERSION;
  runtimeEpoch: string;
  entries: ChangeEvidenceEntry[];
  /** Highest sequence the reader may acknowledge from this response. */
  nextCursor: number;
  /** Frames the spool could not retain; already present as stream-gap frames. */
  pendingGap: boolean;
  capabilities: ProviderChangeCapabilities[];
}

/** `POST /change-evidence/ack` request. */
export interface ChangeEvidenceAckRequest {
  runtimeEpoch: string;
  /** Every entry with `seq <= upTo` is durable in the backend ledger. */
  upTo: number;
  retainedBodyIds: string[];
  /** Bodies the backend durably recorded as unavailable (fetch failed). */
  unavailableBodyIds: string[];
}
