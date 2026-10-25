import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import type { ChangeDiffTarget, FileTabData } from "@/types/paneLayout";

/**
 * Diff tab targets (docs/architecture/change-tracking.md, Client contract).
 *
 * A diff tab shows backend hunks for exactly one target: a historical diff
 * identity, or an explicit live "current workspace file" row of an
 * environment projection. These helpers name that target for tabs created
 * before targets existed and decide when two requests show the same thing.
 */

function basename(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return index >= 0 ? filePath.slice(index + 1) : filePath;
}

/**
 * The live target a legacy `isDiff` tab (restored from an old layout or opened
 * by a caller that predates change tracking) stands for: this environment's
 * current file at `filePath`.
 */
export function legacyLiveDiffTarget(environmentId: string, filePath: string): ChangeDiffTarget {
  return {
    kind: "live",
    resourceKey: environmentChangeResourceKey(environmentId),
    path: filePath,
    title: basename(filePath),
  };
}

/** What a file tab's diff view shows, or undefined for a plain file tab. */
export function fileTabChangeDiffTarget(
  fileData: Pick<FileTabData, "filePath" | "isDiff" | "changeDiff">,
  environmentId: string,
): ChangeDiffTarget | undefined {
  if (fileData.changeDiff) return fileData.changeDiff;
  return fileData.isDiff ? legacyLiveDiffTarget(environmentId, fileData.filePath) : undefined;
}

/**
 * Whether two targets show the same diff: the same historical identity, or
 * the same live resource and file (path id, else path, else pinned row).
 */
export function sameChangeDiffTarget(left: ChangeDiffTarget, right: ChangeDiffTarget): boolean {
  if (left.kind === "historical" || right.kind === "historical") {
    return (
      left.kind === "historical" &&
      right.kind === "historical" &&
      left.diffIdentityId === right.diffIdentityId
    );
  }
  if (left.resourceKey !== right.resourceKey) return false;
  if (left.pathId !== undefined && right.pathId !== undefined) return left.pathId === right.pathId;
  if (left.path !== undefined && right.path !== undefined) return left.path === right.path;
  if (left.rowId !== undefined && right.rowId !== undefined) {
    return left.rowId === right.rowId && left.revision === right.revision;
  }
  return false;
}
