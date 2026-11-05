/**
 * The bound on the file rows one measurement stores.
 *
 * A net measurement lists every changed file, so one bulk change is listed
 * again by every turn, thread and environment measurement that spans it. Past
 * the cap the measurement keeps its true totals and goes partial with
 * `FILE_ROWS_CAPPED_REASON`. The caller still seals over the full list, so a
 * change past the cap produces a new measurement.
 */

import {
  FILE_ROWS_CAPPED_REASON,
  type ChangeMeasurement,
} from "@orkestrator/protocol/change-measurements";
import type { MeasurementFileRecord } from "./change-ledger.js";

function hasTextChange(file: MeasurementFileRecord): boolean {
  return file.fileKind === "text" && ((file.additions ?? 0) > 0 || (file.deletions ?? 0) > 0);
}

/** Rows with text changes first, then the rest, each by path; never locale-dependent. */
function byReadingPriority(left: MeasurementFileRecord, right: MeasurementFileRecord): number {
  const priority = Number(hasTextChange(right)) - Number(hasTextChange(left));
  if (priority !== 0) return priority;
  return left.pathId < right.pathId ? -1 : left.pathId > right.pathId ? 1 : 0;
}

/** A row the comparison already counted in `omittedFileCount` when it listed it. */
function alreadyCountedOmission(file: MeasurementFileRecord): boolean {
  return file.status === "unknown" && (file.reason?.startsWith("omitted-") ?? false);
}

/**
 * The rows to store for `files` and the draft that says so. At or under `cap`
 * both come back unchanged, in their original order.
 */
export function capMeasurementFiles<
  Draft extends { completeness: ChangeMeasurement["completeness"] },
>(
  draft: Draft,
  files: readonly MeasurementFileRecord[],
  cap: number,
): { draft: Draft; rows: readonly MeasurementFileRecord[] } {
  if (files.length <= cap) return { draft, rows: files };
  const ordered = files.toSorted(byReadingPriority);
  const dropped = ordered.slice(cap);
  const { completeness } = draft;
  return {
    draft: {
      ...draft,
      completeness: {
        files: "partial",
        // First, so the 32-reason limit and the projection's 16 keep it.
        reasons: [
          FILE_ROWS_CAPPED_REASON,
          ...completeness.reasons.filter((reason) => reason !== FILE_ROWS_CAPPED_REASON),
        ].slice(0, 32),
        omittedFileCount:
          completeness.omittedFileCount === null
            ? null
            : completeness.omittedFileCount +
              dropped.filter((file) => !alreadyCountedOmission(file)).length,
      },
    },
    rows: ordered.slice(0, cap),
  };
}
