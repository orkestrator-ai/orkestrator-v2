/**
 * DiffEngine for captured snapshots (raw-lines-v1 over raw-bytes-v1).
 *
 * Counts and bodies come from the same immutable manifests and blobs, so a
 * historical badge and its expanded diff can never disagree, and neither ever
 * reads today's worktree. Rename pairing is exact-content only, with a
 * deterministic path tie-break; a modified rename stays delete + add.
 *
 * Every limitation stays visible: an omitted file is a changed-or-unknown
 * row with a reason, never a zero; binary and gitlink rows keep their file
 * identity with not-applicable text counts.
 */

import {
  addLineCounts,
  exactCount,
  notApplicableCount,
  unknownCount,
  type LineCount,
} from "@orkestrator/protocol/change-measurements";
import type {
  ChangeDiffFileBody,
  ChangeFileKind,
  ChangeFileStatus,
} from "@orkestrator/protocol/change-resources";
import {
  countRawLineChanges,
  countRawLines,
  diffRawLines,
  isProbablyBinary,
  type RawLineDiffBudget,
} from "@orkestrator/protocol/node/change-tracking/raw-line-diff";
import {
  displayPath,
  type Manifest,
  type ManifestEntry,
  type ManifestOmission,
} from "./capture.js";
import type { ObjectStore } from "./object-store.js";

export interface SnapshotFileChange {
  pathId: string;
  oldPathId: string | null;
  newPathId: string | null;
  status: ChangeFileStatus;
  fileKind: ChangeFileKind;
  oldEntry: ManifestEntry | null;
  newEntry: ManifestEntry | null;
  additions: LineCount;
  deletions: LineCount;
  reason: string | null;
}

export interface SnapshotComparison {
  files: SnapshotFileChange[];
  additions: LineCount;
  deletions: LineCount;
  changedFiles: number;
  completeness: "complete" | "partial";
  reasons: string[];
  omittedFileCount: number;
  unstable: boolean;
}

export const EMPTY_MANIFEST: Manifest = {
  v: 1,
  root: "empty",
  entries: [],
  omitted: [],
  unstable: [],
};

function kindOf(entry: ManifestEntry): ChangeFileKind {
  if (entry.m === "160000") return "gitlink";
  if (entry.m === "120000") return "symlink";
  return "text";
}

async function textCounts(
  store: ObjectStore,
  before: ManifestEntry | null,
  after: ManifestEntry | null,
  budget: Partial<RawLineDiffBudget>,
): Promise<{
  additions: LineCount;
  deletions: LineCount;
  fileKind: ChangeFileKind;
  reason: string | null;
}> {
  const kind =
    (after ?? before)!.m === "160000" || before?.m === "160000"
      ? "gitlink"
      : kindOf((after ?? before)!);
  if (kind === "gitlink") {
    return {
      additions: notApplicableCount(),
      deletions: notApplicableCount(),
      fileKind: "gitlink",
      reason: null,
    };
  }
  const oldBytes = before ? await store.get(before.o) : new Uint8Array();
  const newBytes = after ? await store.get(after.o) : new Uint8Array();
  if (!oldBytes || !newBytes) {
    return {
      additions: unknownCount(),
      deletions: unknownCount(),
      fileKind: kind,
      reason: "body-unavailable",
    };
  }
  if (isProbablyBinary(oldBytes) || isProbablyBinary(newBytes)) {
    return {
      additions: notApplicableCount(),
      deletions: notApplicableCount(),
      fileKind: "binary",
      reason: null,
    };
  }
  if (!before)
    return {
      additions: exactCount(countRawLines(newBytes)),
      deletions: exactCount(0),
      fileKind: kind,
      reason: null,
    };
  if (!after)
    return {
      additions: exactCount(0),
      deletions: exactCount(countRawLines(oldBytes)),
      fileKind: kind,
      reason: null,
    };
  const counted = countRawLineChanges(oldBytes, newBytes, budget);
  if (counted.kind === "limit") {
    return {
      additions: unknownCount(),
      deletions: unknownCount(),
      fileKind: kind,
      reason: `complexity-limit-${counted.reason}`,
    };
  }
  return {
    additions: exactCount(counted.additions),
    deletions: exactCount(counted.deletions),
    fileKind: kind,
    reason: null,
  };
}

/** Compare two manifests. `before` null compares against an empty tree. */
export async function compareManifests(
  store: ObjectStore,
  before: Manifest | null,
  after: Manifest,
  budget: Partial<RawLineDiffBudget> = {},
): Promise<SnapshotComparison> {
  const base = before ?? EMPTY_MANIFEST;
  const oldEntries = new Map(base.entries.map((entry) => [entry.p, entry]));
  const newEntries = new Map(after.entries.map((entry) => [entry.p, entry]));
  const oldOmitted = new Map(base.omitted.map((entry) => [entry.p, entry]));
  const newOmitted = new Map(after.omitted.map((entry) => [entry.p, entry]));
  const files: SnapshotFileChange[] = [];
  const reasons = new Set<string>();
  let omittedFileCount = 0;

  const deleted: ManifestEntry[] = [];
  const added: ManifestEntry[] = [];
  const omittedPaths = new Set<string>([...oldOmitted.keys(), ...newOmitted.keys()]);

  for (const pathId of omittedPaths) {
    const oldOmission = oldOmitted.get(pathId);
    const newOmission = newOmitted.get(pathId);
    if (
      oldOmission &&
      newOmission &&
      oldOmission.stamp &&
      oldOmission.stamp === newOmission.stamp
    ) {
      // Both endpoints skipped the same unchanged-looking file: unverified.
      reasons.add("omitted-unverified");
      omittedFileCount++;
      continue;
    }
    const omission = (newOmission ?? oldOmission) as ManifestOmission;
    omittedFileCount++;
    reasons.add(`omitted-${omission.reason}`);
    const oldEntry = oldEntries.get(pathId) ?? null;
    const newEntry = newEntries.get(pathId) ?? null;
    files.push({
      pathId,
      oldPathId: oldEntry || oldOmission ? pathId : null,
      newPathId: newEntry || newOmission ? pathId : null,
      status: "unknown",
      fileKind: "unknown",
      oldEntry,
      newEntry,
      additions: unknownCount(),
      deletions: unknownCount(),
      reason: `omitted-${omission.reason}`,
    });
  }

  for (const [pathId, oldEntry] of oldEntries) {
    if (omittedPaths.has(pathId)) continue;
    const newEntry = newEntries.get(pathId);
    if (!newEntry) {
      deleted.push(oldEntry);
      continue;
    }
    if (newEntry.o === oldEntry.o && newEntry.m === oldEntry.m) continue;
    if (newEntry.o === oldEntry.o) {
      files.push({
        pathId,
        oldPathId: pathId,
        newPathId: pathId,
        status: "mode-changed",
        fileKind: kindOf(newEntry),
        oldEntry,
        newEntry,
        additions: exactCount(0),
        deletions: exactCount(0),
        reason: null,
      });
      continue;
    }
    const typeChanged = kindOf(oldEntry) !== kindOf(newEntry);
    const counts = await textCounts(store, oldEntry, newEntry, budget);
    if (counts.reason) reasons.add(counts.reason);
    files.push({
      pathId,
      oldPathId: pathId,
      newPathId: pathId,
      status: typeChanged ? "type-changed" : "modified",
      fileKind: counts.fileKind,
      oldEntry,
      newEntry,
      additions: counts.additions,
      deletions: counts.deletions,
      reason: counts.reason,
    });
  }
  for (const [pathId, newEntry] of newEntries) {
    if (omittedPaths.has(pathId) || oldEntries.has(pathId)) continue;
    added.push(newEntry);
  }

  // Exact-content rename pairing, deterministic by path order.
  const addedByObject = new Map<string, ManifestEntry[]>();
  for (const entry of added) {
    if (entry.m === "160000") continue;
    const list = addedByObject.get(entry.o) ?? [];
    list.push(entry);
    addedByObject.set(entry.o, list);
  }
  const paired = new Set<string>();
  const sortedDeleted = [...deleted].sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  for (const list of addedByObject.values())
    list.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  const unpairedDeleted: ManifestEntry[] = [];
  for (const oldEntry of sortedDeleted) {
    const candidates = oldEntry.m === "160000" ? undefined : addedByObject.get(oldEntry.o);
    const match = candidates?.find((entry) => !paired.has(entry.p));
    if (!match) {
      unpairedDeleted.push(oldEntry);
      continue;
    }
    paired.add(match.p);
    files.push({
      pathId: match.p,
      oldPathId: oldEntry.p,
      newPathId: match.p,
      status: "renamed",
      fileKind: kindOf(match),
      oldEntry,
      newEntry: match,
      additions: exactCount(0),
      deletions: exactCount(0),
      reason: null,
    });
  }
  for (const oldEntry of unpairedDeleted) {
    const counts = await textCounts(store, oldEntry, null, budget);
    if (counts.reason) reasons.add(counts.reason);
    files.push({
      pathId: oldEntry.p,
      oldPathId: oldEntry.p,
      newPathId: null,
      status: "deleted",
      fileKind: counts.fileKind,
      oldEntry,
      newEntry: null,
      additions: counts.additions,
      deletions: counts.deletions,
      reason: counts.reason,
    });
  }
  for (const newEntry of added) {
    if (paired.has(newEntry.p)) continue;
    const counts = await textCounts(store, null, newEntry, budget);
    if (counts.reason) reasons.add(counts.reason);
    files.push({
      pathId: newEntry.p,
      oldPathId: null,
      newPathId: newEntry.p,
      status: "added",
      fileKind: counts.fileKind,
      oldEntry: null,
      newEntry,
      additions: counts.additions,
      deletions: counts.deletions,
      reason: counts.reason,
    });
  }

  files.sort((left, right) =>
    left.pathId < right.pathId ? -1 : left.pathId > right.pathId ? 1 : 0,
  );
  let additions: LineCount = exactCount(0);
  let deletions: LineCount = exactCount(0);
  let changedFiles = 0;
  for (const file of files) {
    additions = addLineCounts(additions, file.additions);
    deletions = addLineCounts(deletions, file.deletions);
    changedFiles++;
  }
  const unstable = base.unstable.length > 0 || after.unstable.length > 0;
  if (unstable) reasons.add("changed-during-capture");
  const partial =
    omittedFileCount > 0 || files.some((file) => file.additions.quality === "unknown");
  return {
    files,
    additions,
    deletions,
    changedFiles,
    completeness: partial ? "partial" : "complete",
    reasons: [...reasons].sort(),
    omittedFileCount,
    unstable,
  };
}

/** Backend-rendered hunks for selected files of a comparison. */
export async function renderSnapshotBodies(
  store: ObjectStore,
  files: readonly SnapshotFileChange[],
  budget: Partial<RawLineDiffBudget> & { maxBatchBytes?: number } = {},
): Promise<ChangeDiffFileBody[]> {
  const bodies: ChangeDiffFileBody[] = [];
  let spent = 0;
  const maxBatch = budget.maxBatchBytes ?? 1024 * 1024;
  for (const file of files) {
    const base = {
      pathId: file.pathId,
      oldPathDisplay: file.oldPathId ? displayPath(file.oldPathId) : null,
      newPathDisplay: file.newPathId ? displayPath(file.newPathId) : null,
      status: file.status,
      fileKind: file.fileKind,
    };
    if (file.fileKind === "binary" || file.fileKind === "gitlink" || file.status === "unknown") {
      bodies.push({
        ...base,
        bodyAvailability: file.status === "unknown" ? "not-retained" : "available",
        reasonKey: file.reason ?? `changes.body.${file.fileKind}`,
        hunks: [],
        truncated: false,
      });
      continue;
    }
    const oldBytes =
      file.oldEntry && file.oldEntry.m !== "160000"
        ? await store.get(file.oldEntry.o)
        : new Uint8Array();
    const newBytes =
      file.newEntry && file.newEntry.m !== "160000"
        ? await store.get(file.newEntry.o)
        : new Uint8Array();
    if (!oldBytes || !newBytes) {
      bodies.push({
        ...base,
        bodyAvailability: "expired",
        reasonKey: "changes.body.expired",
        hunks: [],
        truncated: false,
      });
      continue;
    }
    if (spent >= maxBatch) {
      bodies.push({
        ...base,
        bodyAvailability: "available",
        reasonKey: "changes.body.batch-limit",
        hunks: [],
        truncated: true,
      });
      continue;
    }
    const diff = diffRawLines(oldBytes, newBytes, budget);
    spent += oldBytes.length + newBytes.length;
    if (diff.kind === "diff") {
      bodies.push({
        ...base,
        bodyAvailability: "available",
        reasonKey: null,
        hunks: diff.hunks,
        truncated: diff.truncated,
      });
    } else {
      bodies.push({
        ...base,
        bodyAvailability: "available",
        reasonKey: `changes.body.${diff.reason}`,
        hunks: [],
        truncated: true,
      });
    }
  }
  return bodies;
}
