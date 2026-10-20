/**
 * Canonical file-change measurement shared by every surface.
 *
 * A measurement names one comparison: its scope (what question it answers),
 * its endpoints or evidence, the policies used to count it, and every known
 * limitation. Zero is a recorded outcome; missing data is `null` with a
 * matching quality, never a zero. Clients render these values; they never
 * compute, combine or reinterpret them.
 *
 * Portable: no filesystem, Git, SQLite or provider SDK imports. The backend
 * (`apps/backend/src/core/change-tracking/`) is the only producer.
 * See `docs/architecture/change-tracking.md`.
 */

import { isPlainRecord } from "./field-validation.js";

export const CHANGE_MEASUREMENT_SCHEMA_VERSION = 1 as const;

/**
 * Which comparison a measurement answers. Scopes are never summed into one
 * another: staged + unstaged is not uncommitted-net, and turn or tool counts
 * do not add up to thread-net.
 */
export const MEASUREMENT_SCOPES = [
  "environment-net",
  "uncommitted-net",
  "staged",
  "unstaged",
  "turn-net",
  "provider-turn-diff",
  "thread-net",
  "tool-effect",
  "observation-window",
  "tool-payload",
  "operation-volume",
  "commit",
  "pull-request",
] as const;
export type MeasurementScope = (typeof MEASUREMENT_SCOPES)[number];

/** Scopes whose endpoints come from a persisted baseline lineage. */
export const BASELINE_SCOPES: ReadonlySet<MeasurementScope> = new Set([
  "environment-net",
  "thread-net",
]);

/** Scopes that compare two captured snapshots. */
export const SNAPSHOT_ENDPOINT_SCOPES: ReadonlySet<MeasurementScope> = new Set([
  "turn-net",
  "thread-net",
  "tool-effect",
  "observation-window",
]);

export const EVIDENCE_ORIGINS = [
  "captured-endpoints",
  "git-observation",
  "provider-counts",
  "provider-patch",
  "input-fragments",
  "content-only",
  "legacy-import",
] as const;
export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

export const COUNT_QUALITIES = [
  "complete",
  "partial",
  "estimated",
  "unknown",
  "not-applicable",
] as const;
export type CountQuality = (typeof COUNT_QUALITIES)[number];

export const COUNT_BOUNDS = ["exact", "lower", "upper", "none"] as const;
export type CountBound = (typeof COUNT_BOUNDS)[number];

/**
 * One line total. `value` is null exactly when nothing numeric is known; a
 * partial subtotal is not a lower bound unless `bound` says so.
 */
export interface LineCount {
  value: number | null;
  quality: CountQuality;
  bound: CountBound;
}

export const EXECUTION_STATES = [
  "proposed",
  "awaiting-approval",
  "running",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "unknown",
  "not-applicable",
] as const;
export type MeasurementExecution = (typeof EXECUTION_STATES)[number];

export const EXECUTION_OCCURRENCES = [
  "not-started",
  "started",
  "did-not-run",
  "unknown",
  "not-applicable",
] as const;
export type MeasurementExecutionOccurrence = (typeof EXECUTION_OCCURRENCES)[number];

export const EFFECT_CLAIMS = [
  "proposal",
  "provider-reported",
  "workspace-observed",
  "unknown",
  "not-applicable",
] as const;
export type EffectClaim = (typeof EFFECT_CLAIMS)[number];

export const FINALITIES = ["provisional", "final", "interrupted", "unknown"] as const;
export type MeasurementFinality = (typeof FINALITIES)[number];

export const CONSISTENCIES = [
  "stable-observation",
  "coordinated-interval",
  "atomic-snapshot",
  "changed-during-capture",
  "unknown",
] as const;
export type CaptureConsistency = (typeof CONSISTENCIES)[number];

export const BEFORE_BOUNDARIES = [
  "fresh-before",
  "prior-observation",
  "late-start",
  "provider-declared",
  "unknown",
  "not-applicable",
] as const;
export type BeforeBoundary = (typeof BEFORE_BOUNDARIES)[number];

export const AFTER_BOUNDARIES = [
  "after-terminal",
  "running-observation",
  "later-recovery",
  "provider-declared",
  "unknown",
  "not-applicable",
] as const;
export type AfterBoundary = (typeof AFTER_BOUNDARIES)[number];

export const ATTRIBUTION_BASES = [
  "workspace-observation",
  "provider-reported",
  "proposal",
  "unknown",
] as const;
export type AttributionBasis = (typeof ATTRIBUTION_BASES)[number];

export const WRITER_ISOLATIONS = ["verified-isolated", "shared", "unknown"] as const;
export type WriterIsolation = (typeof WRITER_ISOLATIONS)[number];

export const OVERLAPS = ["known-overlap", "none-observed", "unknown"] as const;
export type OverlapState = (typeof OVERLAPS)[number];

export const FILE_COMPLETENESS = ["complete", "partial", "unknown"] as const;
export type FileCompleteness = (typeof FILE_COMPLETENESS)[number];

export interface MeasurementLogicalOwner {
  environmentId?: string;
  threadId?: string;
  threadSegmentId?: string;
  turnId?: string;
  operationId?: string;
  attemptId?: string;
}

export interface EvidenceRef {
  evidenceId: string;
  evidenceRevision: number;
  /** Per-file selection within a retained multifile patch. */
  selectedPaths?: readonly string[];
}

export interface MeasurementTotals {
  additions: LineCount;
  deletions: LineCount;
  /** Changed file identities, including binary, mode-only and rename changes. */
  changedFiles: number | null;
  /** Union of operation paths; never presented as a changed-file count. */
  touchedFiles?: number | null;
  /** Lines supplied in one content-only body (for example a Write). */
  contentLines?: number | null;
}

export interface ChangeMeasurement {
  schemaVersion: typeof CHANGE_MEASUREMENT_SCHEMA_VERSION;
  measurementId: string;
  worktreeId: string;
  worktreeIncarnation: string;
  scope: MeasurementScope;
  logicalOwner: MeasurementLogicalOwner;
  baselineVersion: string | null;
  beforeSnapshotId: string | null;
  afterSnapshotId: string | null;
  evidenceRefs: readonly EvidenceRef[];
  capabilityRevision: string | null;
  origin: EvidenceOrigin;
  algorithmPolicyId: string;
  representationPolicyId: string;
  execution: MeasurementExecution;
  executionOccurrence: MeasurementExecutionOccurrence;
  effectClaim: EffectClaim;
  finality: MeasurementFinality;
  consistency: CaptureConsistency;
  boundary: { before: BeforeBoundary; after: AfterBoundary };
  attribution: {
    basis: AttributionBasis;
    writerIsolation: WriterIsolation;
    overlap: OverlapState;
  };
  completeness: {
    files: FileCompleteness;
    reasons: string[];
    omittedFileCount: number | null;
  };
  totals: MeasurementTotals;
  diffIdentityId: string | null;
  createdAt: string;
  supersedesMeasurementId: string | null;
}

// ---------------------------------------------------------------------------
// LineCount constructors. Producers use these rather than object literals so a
// null value can never carry an "exact" bound.
// ---------------------------------------------------------------------------

export function exactCount(value: number): LineCount {
  return { value, quality: "complete", bound: "exact" };
}

export function partialCount(value: number, bound: CountBound = "none"): LineCount {
  return { value, quality: "partial", bound };
}

export function estimatedCount(value: number): LineCount {
  return { value, quality: "estimated", bound: "none" };
}

export function unknownCount(): LineCount {
  return { value: null, quality: "unknown", bound: "none" };
}

export function notApplicableCount(): LineCount {
  return { value: null, quality: "not-applicable", bound: "none" };
}

/** True for a finite, nonnegative safe integer. */
export function isCountValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Combine two independent per-file counts into an aggregate. Quality degrades
 * to the weakest input: one unknown member makes the total partial (its known
 * part) rather than silently complete. `not-applicable` members (binary files)
 * contribute nothing and do not weaken text totals.
 */
export function addLineCounts(left: LineCount, right: LineCount): LineCount {
  if (left.quality === "not-applicable") return right;
  if (right.quality === "not-applicable") return left;
  const value = (left.value ?? 0) + (right.value ?? 0);
  const known = left.value !== null || right.value !== null;
  if (left.quality === "complete" && right.quality === "complete") return exactCount(value);
  if (!known) return unknownCount();
  if (left.quality === "estimated" || right.quality === "estimated") {
    return left.quality === "unknown" || right.quality === "unknown"
      ? partialCount(value)
      : estimatedCount(value);
  }
  return partialCount(value);
}

/** The identity of zero text changes over a complete comparison. */
export const ZERO_COUNT: LineCount = Object.freeze(exactCount(0));

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface MeasurementValidationIssue {
  path: string;
  message: string;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isId(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isNullableId(value: unknown): value is string | null {
  return value === null || isId(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

export function lineCountIssues(value: unknown, path: string): MeasurementValidationIssue[] {
  if (!isPlainRecord(value)) return [{ path, message: "expected a LineCount object" }];
  const issues: MeasurementValidationIssue[] = [];
  if (!oneOf(COUNT_QUALITIES, value.quality)) {
    issues.push({ path: `${path}.quality`, message: "unknown count quality" });
  }
  if (!oneOf(COUNT_BOUNDS, value.bound)) {
    issues.push({ path: `${path}.bound`, message: "unknown count bound" });
  }
  if (value.value === null) {
    if (value.quality !== "unknown" && value.quality !== "not-applicable") {
      issues.push({ path: `${path}.value`, message: "null requires unknown or not-applicable" });
    }
    if (value.bound !== "none") {
      issues.push({ path: `${path}.bound`, message: "null cannot carry a bound" });
    }
  } else if (!isCountValue(value.value)) {
    issues.push({ path: `${path}.value`, message: "expected a nonnegative safe integer" });
  } else if (value.quality === "unknown" || value.quality === "not-applicable") {
    issues.push({ path: `${path}.value`, message: `${String(value.quality)} requires null` });
  } else if (value.quality === "complete" && value.bound !== "exact") {
    issues.push({ path: `${path}.bound`, message: "complete counts are exact" });
  } else if (value.quality !== "complete" && value.bound === "exact") {
    issues.push({ path: `${path}.bound`, message: "only complete counts are exact" });
  }
  return issues;
}

function nullableCountIssue(
  value: unknown,
  path: string,
  optional: boolean,
): MeasurementValidationIssue[] {
  if (value === undefined && optional) return [];
  if (value === null || isCountValue(value)) return [];
  return [{ path, message: "expected a nonnegative safe integer or null" }];
}

/**
 * Validate a measurement before it enters shared state. Field rules depend on
 * scope: payload-only evidence has no invented baseline, and endpoint scopes
 * name their snapshots.
 */
export function measurementIssues(value: unknown): MeasurementValidationIssue[] {
  if (!isPlainRecord(value)) return [{ path: "$", message: "expected an object" }];
  const m = value;
  const issues: MeasurementValidationIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  if (m.schemaVersion !== CHANGE_MEASUREMENT_SCHEMA_VERSION) push("schemaVersion", "unsupported");
  if (!isId(m.measurementId)) push("measurementId", "expected an id");
  if (!isId(m.worktreeId)) push("worktreeId", "expected an id");
  if (!isId(m.worktreeIncarnation)) push("worktreeIncarnation", "expected an id");
  if (!oneOf(MEASUREMENT_SCOPES, m.scope)) push("scope", "unknown scope");
  if (!isPlainRecord(m.logicalOwner)) push("logicalOwner", "expected an object");
  else {
    for (const [key, id] of Object.entries(m.logicalOwner)) {
      if (id !== undefined && !isId(id)) push(`logicalOwner.${key}`, "expected an id");
    }
  }
  if (!isNullableId(m.baselineVersion)) push("baselineVersion", "expected an id or null");
  if (!isNullableId(m.beforeSnapshotId)) push("beforeSnapshotId", "expected an id or null");
  if (!isNullableId(m.afterSnapshotId)) push("afterSnapshotId", "expected an id or null");
  if (!Array.isArray(m.evidenceRefs)) push("evidenceRefs", "expected an array");
  else {
    m.evidenceRefs.forEach((ref, index) => {
      if (!isPlainRecord(ref) || !isId(ref.evidenceId) || !isCountValue(ref.evidenceRevision)) {
        push(`evidenceRefs[${index}]`, "expected {evidenceId, evidenceRevision}");
      }
    });
  }
  if (!isNullableId(m.capabilityRevision)) push("capabilityRevision", "expected an id or null");
  if (!oneOf(EVIDENCE_ORIGINS, m.origin)) push("origin", "unknown origin");
  if (!isId(m.algorithmPolicyId)) push("algorithmPolicyId", "expected an id");
  if (!isId(m.representationPolicyId)) push("representationPolicyId", "expected an id");
  if (!oneOf(EXECUTION_STATES, m.execution)) push("execution", "unknown execution state");
  if (!oneOf(EXECUTION_OCCURRENCES, m.executionOccurrence)) {
    push("executionOccurrence", "unknown occurrence");
  }
  if (!oneOf(EFFECT_CLAIMS, m.effectClaim)) push("effectClaim", "unknown claim");
  if (!oneOf(FINALITIES, m.finality)) push("finality", "unknown finality");
  if (!oneOf(CONSISTENCIES, m.consistency)) push("consistency", "unknown consistency");
  if (!isPlainRecord(m.boundary)) push("boundary", "expected an object");
  else {
    if (!oneOf(BEFORE_BOUNDARIES, m.boundary.before)) push("boundary.before", "unknown");
    if (!oneOf(AFTER_BOUNDARIES, m.boundary.after)) push("boundary.after", "unknown");
  }
  if (!isPlainRecord(m.attribution)) push("attribution", "expected an object");
  else {
    if (!oneOf(ATTRIBUTION_BASES, m.attribution.basis)) push("attribution.basis", "unknown");
    if (!oneOf(WRITER_ISOLATIONS, m.attribution.writerIsolation)) {
      push("attribution.writerIsolation", "unknown");
    }
    if (!oneOf(OVERLAPS, m.attribution.overlap)) push("attribution.overlap", "unknown");
  }
  if (!isPlainRecord(m.completeness)) push("completeness", "expected an object");
  else {
    if (!oneOf(FILE_COMPLETENESS, m.completeness.files)) push("completeness.files", "unknown");
    if (
      !Array.isArray(m.completeness.reasons) ||
      m.completeness.reasons.length > 32 ||
      !m.completeness.reasons.every((reason) => isId(reason, 128))
    ) {
      push("completeness.reasons", "expected at most 32 reason keys");
    }
    issues.push(
      ...nullableCountIssue(
        m.completeness.omittedFileCount,
        "completeness.omittedFileCount",
        false,
      ),
    );
  }
  if (!isPlainRecord(m.totals)) push("totals", "expected an object");
  else {
    issues.push(...lineCountIssues(m.totals.additions, "totals.additions"));
    issues.push(...lineCountIssues(m.totals.deletions, "totals.deletions"));
    issues.push(...nullableCountIssue(m.totals.changedFiles, "totals.changedFiles", false));
    issues.push(...nullableCountIssue(m.totals.touchedFiles, "totals.touchedFiles", true));
    issues.push(...nullableCountIssue(m.totals.contentLines, "totals.contentLines", true));
  }
  if (!isNullableId(m.diffIdentityId)) push("diffIdentityId", "expected an id or null");
  if (!isIsoTimestamp(m.createdAt)) push("createdAt", "expected an ISO timestamp");
  if (!isNullableId(m.supersedesMeasurementId)) push("supersedesMeasurementId", "expected id");

  if (issues.length > 0) return issues;

  // Scope-specific rules.
  const scope = m.scope as MeasurementScope;
  if (scope === "tool-payload" || scope === "provider-turn-diff") {
    if (m.baselineVersion !== null) push("baselineVersion", "payload evidence has no baseline");
    if (m.beforeSnapshotId !== null || m.afterSnapshotId !== null) {
      push("beforeSnapshotId", "payload evidence does not invent snapshots");
    }
    if (m.effectClaim === "workspace-observed") {
      push("effectClaim", "payload evidence is not a workspace observation");
    }
  }
  if (BASELINE_SCOPES.has(scope) && m.baselineVersion === null && m.finality !== "unknown") {
    const reasons = (m.completeness as { reasons: string[] }).reasons;
    if (!reasons.includes("baseline-unavailable")) {
      push("baselineVersion", "baseline scopes require a baseline or baseline-unavailable");
    }
  }
  // A captured comparison names both endpoints; one with a missing endpoint
  // must say its coverage is unknown rather than publish counts.
  if (
    m.origin === "captured-endpoints" &&
    SNAPSHOT_ENDPOINT_SCOPES.has(scope) &&
    (m.beforeSnapshotId === null || m.afterSnapshotId === null) &&
    (m.completeness as { files: string }).files !== "unknown"
  ) {
    push("afterSnapshotId", "captured endpoints require both snapshot ids");
  }
  const attribution = m.attribution as ChangeMeasurement["attribution"];
  if (
    attribution.writerIsolation === "verified-isolated" &&
    attribution.overlap !== "none-observed"
  ) {
    push("attribution.writerIsolation", "verified isolation cannot coexist with overlap");
  }
  return issues;
}

export function isChangeMeasurement(value: unknown): value is ChangeMeasurement {
  return measurementIssues(value).length === 0;
}
