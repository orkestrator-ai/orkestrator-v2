/**
 * Count one piece of provider evidence under CountPolicyV1.
 *
 * Patches go through the hunk-aware parser; paired replacement sides through
 * the bounded raw-lines-v1 diff; declared numbers are taken as declared. A
 * missing side, unavailable body or exceeded budget yields an explicit
 * unknown/partial count with a reason — never zero, and never the length of
 * both inputs presented as changed lines.
 */

import type { FileSide, ProviderEvidence } from "../../change-evidence.js";
import {
  addLineCounts,
  exactCount,
  notApplicableCount,
  partialCount,
  unknownCount,
  type EvidenceOrigin,
  type LineCount,
} from "../../change-measurements.js";
import type { ChangeDiffHunk, ChangeFileKind, ChangeFileStatus } from "../../change-resources.js";
import {
  PATCH_PARSER_ALGORITHM_ID,
  PROVIDER_PAYLOAD_REPRESENTATION_ID,
  RAW_LINES_ALGORITHM_ID,
  REPORTED_COUNTS_ALGORITHM_ID,
} from "./count-policy.js";
import {
  countRawLines,
  countRawLineChanges,
  diffRawLines,
  isProbablyBinary,
  type RawLineDiffBudget,
} from "./raw-line-diff.js";
import { parseUnifiedPatch, type UnifiedPatchLimits } from "./unified-patch.js";

/** Resolves an opaque body reference to retained bytes, or null. */
export type EvidenceBodyReader = (bodyId: string) => Uint8Array | null;

export interface PayloadFileResult {
  path: string | null;
  previousPath: string | null;
  status: ChangeFileStatus;
  fileKind: ChangeFileKind;
  additions: LineCount;
  deletions: LineCount;
  contentLines: number | null;
  reasons: string[];
  hunks: ChangeDiffHunk[] | null;
  bodyTruncated: boolean;
}

export interface EvidenceMeasurement {
  origin: EvidenceOrigin;
  algorithmPolicyId: string;
  representationPolicyId: string;
  files: PayloadFileResult[];
  additions: LineCount;
  deletions: LineCount;
  changedFiles: number | null;
  contentLines: number | null;
  reasons: string[];
  fileCompleteness: "complete" | "partial" | "unknown";
}

export interface MeasureOptions {
  /** Produce display hunks as well as counts. */
  withHunks?: boolean;
  selectedPaths?: readonly string[];
  diffBudget?: Partial<RawLineDiffBudget>;
  patchLimits?: Partial<UnifiedPatchLimits>;
}

function sideBytes(
  side: FileSide,
  read: EvidenceBodyReader,
):
  | { state: "present"; bytes: Uint8Array; complete: boolean }
  | { state: "absent" }
  | { state: "unknown"; reason: string } {
  if (side.state === "absent") return side;
  if (side.state === "unknown") return side;
  if (side.body.state !== "available") {
    return { state: "unknown", reason: side.body.unavailableReason ?? "body-unavailable" };
  }
  const bytes = read(side.body.id);
  if (!bytes) return { state: "unknown", reason: "body-unavailable" };
  return { state: "present", bytes, complete: side.body.complete };
}

function emptyMeasurement(
  origin: EvidenceOrigin,
  algorithmPolicyId: string,
  reasons: string[],
): EvidenceMeasurement {
  return {
    origin,
    algorithmPolicyId,
    representationPolicyId: PROVIDER_PAYLOAD_REPRESENTATION_ID,
    files: [],
    additions: unknownCount(),
    deletions: unknownCount(),
    changedFiles: null,
    contentLines: null,
    reasons,
    fileCompleteness: "unknown",
  };
}

function measurePatch(
  evidence: Extract<ProviderEvidence, { kind: "patch" }>,
  read: EvidenceBodyReader,
  options: MeasureOptions,
): EvidenceMeasurement {
  if (evidence.format === "opaque") {
    return emptyMeasurement("provider-patch", PATCH_PARSER_ALGORITHM_ID, ["opaque-patch-format"]);
  }
  if (evidence.body.state !== "available") {
    return emptyMeasurement("provider-patch", PATCH_PARSER_ALGORITHM_ID, [
      evidence.body.unavailableReason ?? "body-unavailable",
    ]);
  }
  const bytes = read(evidence.body.id);
  if (!bytes) {
    return emptyMeasurement("provider-patch", PATCH_PARSER_ALGORITHM_ID, ["body-unavailable"]);
  }
  const parsed = parseUnifiedPatch(new TextDecoder().decode(bytes), options.patchLimits);
  if (parsed.kind === "unsupported") {
    return emptyMeasurement("provider-patch", PATCH_PARSER_ALGORITHM_ID, [
      parsed.reason === "combined-diff" ? "combined-diff-unsupported" : `patch-${parsed.reason}`,
    ]);
  }
  const bodyComplete = evidence.body.complete;
  const complete = parsed.complete && bodyComplete;
  const reasons: string[] = [];
  if (!bodyComplete) reasons.push("patch-body-truncated");
  if (!parsed.complete) reasons.push("patch-incomplete");
  const files: PayloadFileResult[] = parsed.files.map((file) => {
    const text = file.binary
      ? { additions: notApplicableCount(), deletions: notApplicableCount() }
      : file.incomplete || !bodyComplete
        ? { additions: partialCount(file.additions), deletions: partialCount(file.deletions) }
        : { additions: exactCount(file.additions), deletions: exactCount(file.deletions) };
    return {
      path: file.newPath ?? file.oldPath ?? evidence.path ?? null,
      previousPath:
        file.oldPath && file.newPath && file.oldPath !== file.newPath
          ? file.oldPath
          : (evidence.previousPath ?? null),
      status: file.status,
      fileKind: file.binary ? "binary" : "text",
      ...text,
      contentLines: null,
      reasons: file.incomplete ? ["hunk-incomplete"] : [],
      hunks: options.withHunks ? file.hunks : null,
      bodyTruncated: parsed.bodyTruncated,
    };
  });
  let additions: LineCount = exactCount(0);
  let deletions: LineCount = exactCount(0);
  for (const file of files) {
    additions = addLineCounts(additions, file.additions);
    deletions = addLineCounts(deletions, file.deletions);
  }
  if (!complete) {
    additions = additions.value === null ? additions : partialCount(additions.value);
    deletions = deletions.value === null ? deletions : partialCount(deletions.value);
  }
  return {
    origin: "provider-patch",
    algorithmPolicyId: PATCH_PARSER_ALGORITHM_ID,
    representationPolicyId: PROVIDER_PAYLOAD_REPRESENTATION_ID,
    files,
    additions,
    deletions,
    changedFiles: files.length,
    contentLines: null,
    reasons,
    fileCompleteness: complete ? "complete" : "partial",
  };
}

function measureReplacement(
  evidence: Extract<ProviderEvidence, { kind: "replacement" }>,
  read: EvidenceBodyReader,
  options: MeasureOptions,
): EvidenceMeasurement {
  const before = sideBytes(evidence.before, read);
  const after = sideBytes(evidence.after, read);
  const reasons: string[] = [];
  const base = {
    path: evidence.path,
    previousPath: null,
    hunks: null as ChangeDiffHunk[] | null,
    bodyTruncated: false,
    reasons,
  };
  let file: PayloadFileResult;
  let origin: EvidenceOrigin = "input-fragments";
  let contentLines: number | null = null;

  if (before.state === "present" && after.state === "present") {
    const binary = isProbablyBinary(before.bytes) || isProbablyBinary(after.bytes);
    if (binary) {
      file = {
        ...base,
        status: "modified",
        fileKind: "binary",
        additions: notApplicableCount(),
        deletions: notApplicableCount(),
        contentLines: null,
      };
    } else {
      const sidesComplete = before.complete && after.complete;
      if (!sidesComplete) reasons.push("replacement-side-truncated");
      if (options.withHunks) {
        const diff = diffRawLines(before.bytes, after.bytes, options.diffBudget);
        if (diff.kind === "diff" || diff.kind === "counts-only") {
          const make = sidesComplete ? exactCount : partialCount;
          file = {
            ...base,
            status: "modified",
            fileKind: "text",
            additions: make(diff.additions),
            deletions: make(diff.deletions),
            contentLines: null,
            hunks: diff.kind === "diff" ? diff.hunks : null,
            bodyTruncated: diff.kind === "diff" ? diff.truncated : true,
          };
          if (diff.kind === "counts-only") reasons.push(`body-${diff.reason}`);
        } else {
          reasons.push(`complexity-limit-${diff.reason}`);
          file = {
            ...base,
            status: "modified",
            fileKind: "text",
            additions: unknownCount(),
            deletions: unknownCount(),
            contentLines: null,
          };
        }
      } else {
        const counted = countRawLineChanges(before.bytes, after.bytes, options.diffBudget);
        if (counted.kind === "counted") {
          const make = sidesComplete ? exactCount : partialCount;
          file = {
            ...base,
            status: "modified",
            fileKind: "text",
            additions: make(counted.additions),
            deletions: make(counted.deletions),
            contentLines: null,
          };
        } else {
          reasons.push(`complexity-limit-${counted.reason}`);
          file = {
            ...base,
            status: "modified",
            fileKind: "text",
            additions: unknownCount(),
            deletions: unknownCount(),
            contentLines: null,
          };
        }
      }
    }
  } else if (before.state === "absent" && after.state === "present") {
    // Established absence: a verified creation.
    const lines = countRawLines(after.bytes);
    const binary = isProbablyBinary(after.bytes);
    file = {
      ...base,
      status: "added",
      fileKind: binary ? "binary" : "text",
      additions: binary
        ? notApplicableCount()
        : after.complete
          ? exactCount(lines)
          : partialCount(lines),
      deletions: binary ? notApplicableCount() : exactCount(0),
      contentLines: binary ? null : lines,
    };
    contentLines = file.contentLines;
    if (options.withHunks && !binary) {
      const diff = diffRawLines(new Uint8Array(), after.bytes, options.diffBudget);
      if (diff.kind === "diff") {
        file.hunks = diff.hunks;
        file.bodyTruncated = diff.truncated;
      }
    }
  } else if (before.state === "present" && after.state === "absent") {
    const lines = countRawLines(before.bytes);
    const binary = isProbablyBinary(before.bytes);
    file = {
      ...base,
      status: "deleted",
      fileKind: binary ? "binary" : "text",
      additions: binary ? notApplicableCount() : exactCount(0),
      deletions: binary
        ? notApplicableCount()
        : before.complete
          ? exactCount(lines)
          : partialCount(lines),
      contentLines: null,
    };
  } else if (after.state === "present") {
    // Content-only: a Write with unknown prior contents exposes its length
    // but neither additions nor deletions are known.
    origin = "content-only";
    const lines = countRawLines(after.bytes);
    contentLines = lines;
    reasons.push(before.state === "unknown" ? before.reason : "before-unknown");
    file = {
      ...base,
      status: "unknown",
      fileKind: isProbablyBinary(after.bytes) ? "binary" : "text",
      additions: unknownCount(),
      deletions: unknownCount(),
      contentLines: lines,
    };
  } else {
    reasons.push(
      after.state === "unknown"
        ? after.reason
        : before.state === "unknown"
          ? before.reason
          : "sides-unknown",
    );
    file = {
      ...base,
      status: "unknown",
      fileKind: "unknown",
      additions: unknownCount(),
      deletions: unknownCount(),
      contentLines: null,
    };
  }
  if (evidence.extent === "fragment") reasons.push("fragment-extent");
  if (evidence.extent === "notebook-cell") reasons.push("notebook-cell-extent");
  return {
    origin,
    algorithmPolicyId: RAW_LINES_ALGORITHM_ID,
    representationPolicyId: PROVIDER_PAYLOAD_REPRESENTATION_ID,
    files: [file],
    additions: file.additions,
    deletions: file.deletions,
    changedFiles: 1,
    contentLines,
    reasons: [...reasons],
    fileCompleteness: "complete",
  };
}

function countOrUnknown(value: number | null): LineCount {
  return value === null ? unknownCount() : exactCount(value);
}

function measureReportedCounts(
  evidence: Extract<ProviderEvidence, { kind: "reported-counts" }>,
): EvidenceMeasurement {
  const additions = countOrUnknown(evidence.additions);
  const deletions = countOrUnknown(evidence.deletions);
  const reasons = ["provider-declared-counts"];
  if (evidence.additions === null) reasons.push("additions-not-reported");
  if (evidence.deletions === null) reasons.push("deletions-not-reported");
  const file: PayloadFileResult | null = evidence.path
    ? {
        path: evidence.path,
        previousPath: null,
        status: "unknown",
        fileKind: "unknown",
        additions,
        deletions,
        contentLines: evidence.contentLines ?? null,
        reasons: [],
        hunks: null,
        bodyTruncated: false,
      }
    : null;
  return {
    origin: "provider-counts",
    algorithmPolicyId: REPORTED_COUNTS_ALGORITHM_ID,
    representationPolicyId: PROVIDER_PAYLOAD_REPRESENTATION_ID,
    files: file ? [file] : [],
    additions,
    deletions,
    changedFiles: evidence.scope === "file" && evidence.path ? 1 : null,
    contentLines: evidence.contentLines ?? null,
    reasons,
    fileCompleteness: evidence.scope === "file" && evidence.path ? "complete" : "unknown",
  };
}

function measurePathOperation(
  evidence: Extract<ProviderEvidence, { kind: "path-operation" }>,
): EvidenceMeasurement {
  const status: ChangeFileStatus =
    evidence.operation === "add"
      ? "added"
      : evidence.operation === "delete"
        ? "deleted"
        : evidence.operation === "rename"
          ? "renamed"
          : evidence.operation === "modify"
            ? "modified"
            : "unknown";
  return {
    origin: "provider-counts",
    algorithmPolicyId: REPORTED_COUNTS_ALGORITHM_ID,
    representationPolicyId: PROVIDER_PAYLOAD_REPRESENTATION_ID,
    files: [
      {
        path: evidence.path,
        previousPath: evidence.previousPath ?? null,
        status,
        fileKind: "unknown",
        additions: unknownCount(),
        deletions: unknownCount(),
        contentLines: null,
        reasons: ["path-operation-only"],
        hunks: null,
        bodyTruncated: false,
      },
    ],
    additions: unknownCount(),
    deletions: unknownCount(),
    changedFiles: 1,
    contentLines: null,
    reasons: ["path-operation-only"],
    fileCompleteness: "complete",
  };
}

/** Count one evidence item. Pure; reads bodies through `read`. */
export function measureEvidence(
  evidence: ProviderEvidence,
  read: EvidenceBodyReader,
  options: MeasureOptions = {},
): EvidenceMeasurement {
  let measured: EvidenceMeasurement;
  switch (evidence.kind) {
    case "patch":
      measured = measurePatch(evidence, read, options);
      break;
    case "replacement":
      measured = measureReplacement(evidence, read, options);
      break;
    case "reported-counts":
      measured = measureReportedCounts(evidence);
      break;
    case "path-operation":
      measured = measurePathOperation(evidence);
      break;
  }
  if (!options.selectedPaths) return measured;
  const files = measured.files.filter(
    (file) => file.path !== null && options.selectedPaths!.includes(file.path),
  );
  if (files.length === measured.files.length) return measured;
  let additions = files[0]?.additions ?? exactCount(0),
    deletions = files[0]?.deletions ?? exactCount(0);
  for (const file of files.slice(1)) {
    additions = addLineCounts(additions, file.additions);
    deletions = addLineCounts(deletions, file.deletions);
  }
  return {
    ...measured,
    files,
    additions,
    deletions,
    changedFiles: new Set(files.map((f) => f.path)).size,
  };
}

/**
 * Combine the selected evidence items of one tool into a single payload
 * measurement. Items are distinct blocks (for example the edits of a
 * multi-edit); repeated revisions of one block must already have been
 * reduced to one selected revision by the caller.
 */
export function combineEvidenceMeasurements(
  parts: readonly EvidenceMeasurement[],
): EvidenceMeasurement {
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 0) {
    return emptyMeasurement("provider-counts", REPORTED_COUNTS_ALGORITHM_ID, ["no-evidence"]);
  }
  let additions: LineCount = exactCount(0);
  let deletions: LineCount = exactCount(0);
  let contentLines: number | null = 0;
  const reasons = new Set<string>();
  const files: PayloadFileResult[] = [];
  const paths = new Set<string>();
  let unknownFiles = false;
  for (const part of parts) {
    additions = addLineCounts(additions, part.additions);
    deletions = addLineCounts(deletions, part.deletions);
    contentLines =
      contentLines === null || part.contentLines === null ? null : contentLines + part.contentLines;
    for (const reason of part.reasons) reasons.add(reason);
    for (const file of part.files) {
      files.push(file);
      if (file.path) paths.add(file.path);
      else unknownFiles = true;
    }
  }
  const algorithms = new Set(parts.map((part) => part.algorithmPolicyId));
  const origins = new Set(parts.map((part) => part.origin));
  return {
    origin: origins.size === 1 ? parts[0]!.origin : "input-fragments",
    algorithmPolicyId:
      algorithms.size === 1 ? parts[0]!.algorithmPolicyId : [...algorithms].sort().join("+"),
    representationPolicyId: PROVIDER_PAYLOAD_REPRESENTATION_ID,
    files,
    additions,
    deletions,
    changedFiles: unknownFiles ? null : paths.size,
    contentLines,
    reasons: [...reasons].sort(),
    fileCompleteness: parts.every((part) => part.fileCompleteness === "complete")
      ? "complete"
      : parts.some((part) => part.fileCompleteness === "unknown")
        ? "unknown"
        : "partial",
  };
}
